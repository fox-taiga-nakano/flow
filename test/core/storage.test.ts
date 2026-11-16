import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vite-plus/test";

import { Events, logDates } from "../../src/core/events.js";
import { atomic, exists } from "../../src/core/files.js";
import { migrateLegacy } from "../../src/core/migration.js";
import { FlowPaths, localDate } from "../../src/core/paths.js";
import { temp } from "../helpers.js";

const dirs: string[] = [];
async function setup() {
  const dir = await temp();
  dirs.push(dir);
  const p = new FlowPaths(dir);
  await fs.mkdir(p.run, { recursive: true });
  return p;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
const event = (at: string, dryRun: boolean, issue = 1) => ({
  at,
  issue,
  step: "repro",
  event: "test",
  message: "確認",
  dryRun,
});
it("centralizes persistent, runtime, daily logs and virtual paths", async () => {
  const p = await setup();
  expect(p.owned).toBe(path.join(p.root, "state/owned.json"));
  expect(p.lockRegistry).toContain("/state/locks/");
  expect(p.locksPid).toContain("/run/");
  expect(p.assignment(42)).toContain("/state/previews/assignment-42.json");
  expect(p.virtualIssue(42)).toContain("/run/dry-run/issues/42");
  expect(p.virtualWorkspace("x")).toContain("/run/dry-run/workspaces/x");
});
it("migrates every legacy persistent location intact, records a log and is idempotent", async () => {
  const p = await setup();
  const values = {
    "owned.json": { version: 1, workspaces: [], agents: [] },
    "issues.json": [3953],
    "workflow-good.json": "workflow",
    "assignment-preview-3953.json": { agent_assignment: { base_branch: "release" } },
  };
  for (const [name, value] of Object.entries(values)) await atomic(p.legacy(name), value);
  await atomic(p.legacy("locks/registry.json"), { holders: [], waiters: [] });
  const moved = await migrateLegacy(p);
  expect(moved).toHaveLength(5);
  expect(JSON.parse(await fs.readFile(p.issues, "utf8"))).toEqual([3953]);
  expect(JSON.parse(await fs.readFile(p.workflowGood, "utf8"))).toBe("workflow");
  expect(JSON.parse(await fs.readFile(p.assignment(3953), "utf8"))).toEqual(values["assignment-preview-3953.json"]);
  expect(await exists(p.lockRegistry)).toBe(true);
  expect(await exists(p.legacy("owned.json"))).toBe(false);
  expect((await new Events(p.root).read()).some((e) => e.event === "migration")).toBe(true);
  expect(await migrateLegacy(p)).toEqual([]);
});
it("splits legacy event dates at Tokyo midnight and separates production from dry-run", async () => {
  const p = await setup();
  const events = [
    event("2026-10-20T14:59:59Z", true),
    event("2026-10-20T15:00:00Z", true),
    event("2026-10-20T15:01:00Z", false),
  ];
  await fs.writeFile(p.legacy("events.ndjson"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  await migrateLegacy(p);
  expect(JSON.parse((await fs.readFile(p.event("2026-10-20", true), "utf8")).trim())).toEqual(events[0]);
  expect(JSON.parse((await fs.readFile(p.event("2026-10-21", true), "utf8")).trim())).toEqual(events[1]);
  expect(await fs.readFile(p.event("2026-10-21"), "utf8")).toContain("2026-10-20T15:01:00Z");
  expect(await exists(p.legacy("events.ndjson"))).toBe(false);
});
it.each(["owned.json", "issues.json", "workflow-good.json", "locks", "assignment-preview-1.json"])(
  "preflights a conflicting %s without moving any other source",
  async (name) => {
    const p = await setup();
    await atomic(p.legacy("issues.json"), [1]);
    const target =
      name === "owned.json"
        ? p.owned
        : name === "issues.json"
          ? p.issues
          : name === "workflow-good.json"
            ? p.workflowGood
            : name === "locks"
              ? p.locksDirectory
              : p.assignment(1);
    if (name === "locks") {
      await fs.mkdir(p.legacy(name));
      await fs.mkdir(target, { recursive: true });
    } else {
      await atomic(p.legacy(name), {});
      await atomic(target, { existing: true });
    }
    await expect(migrateLegacy(p)).rejects.toThrow("両方");
    expect(await exists(p.legacy("issues.json"))).toBe(true);
    expect(await exists(p.legacy(name))).toBe(true);
  },
);
it("preflights conflicts with a dated log before moving state", async () => {
  const p = await setup();
  await atomic(p.legacy("issues.json"), [1]);
  await fs.writeFile(p.legacy("events.ndjson"), JSON.stringify(event("2026-10-21T01:00:00Z", true)) + "\n");
  await fs.mkdir(path.dirname(p.event("2026-10-21", true)), { recursive: true });
  await fs.writeFile(p.event("2026-10-21", true), "existing");
  await expect(migrateLegacy(p)).rejects.toThrow("両方");
  expect(await exists(p.legacy("issues.json"))).toBe(true);
  expect(await fs.readFile(p.event("2026-10-21", true), "utf8")).toBe("existing");
});
it("refuses corrupt legacy logs and active legacy flow without moving state", async () => {
  const p = await setup();
  await atomic(p.legacy("issues.json"), [1]);
  await fs.writeFile(p.legacy("events.ndjson"), "{broken");
  await expect(migrateLegacy(p)).rejects.toThrow();
  expect(await exists(p.legacy("issues.json"))).toBe(true);
  await fs.rm(p.legacy("events.ndjson"));
  await fs.writeFile(p.flowPid, String(process.pid));
  await expect(migrateLegacy(p)).rejects.toThrow("動作中");
  expect(await exists(p.legacy("issues.json"))).toBe(true);
});
it("migrates legacy virtual directories under run/dry-run", async () => {
  const p = await setup();
  await atomic(p.legacy("virtual/1/example.json"), {});
  await atomic(p.legacy("virtual-workspaces/key/example.json"), {});
  await migrateLegacy(p);
  expect(await exists(path.join(p.virtualIssue(1), "example.json"))).toBe(true);
  expect(await exists(path.join(p.virtualWorkspace("key"), "example.json"))).toBe(true);
});
it("routes events by their own Tokyo date and defaults reads to today", async () => {
  const p = await setup();
  let at = new Date("2026-10-20T14:59:59Z");
  const prod = new Events(p.root, false, () => at);
  const dry = new Events(p.root, true, () => at);
  await prod.add(1, "repro", "before", "前日");
  at = new Date("2026-10-20T15:00:00Z");
  await dry.add(2, "verify", "dry", "予定");
  await prod.add(1, "repro", "today", "本日");
  expect(localDate(at)).toBe("2026-10-21");
  expect((await prod.read()).map((e) => e.event)).toEqual(["today", "dry"]); // stable order within the same timestamp: production then dry-run
  expect((await prod.read(1)).map((e) => e.event)).toEqual(["today"]);
  expect((await prod.read(undefined, { days: 2 })).map((e) => e.event)).toEqual(["before", "today", "dry"]);
  expect((await prod.read(undefined, { date: "2026-10-20" })).map((e) => e.event)).toEqual(["before"]);
  expect(await fs.readFile(p.event("2026-10-21"), "utf8")).not.toContain("予定");
  expect(await fs.readFile(p.event("2026-10-21", true), "utf8")).not.toContain("本日");
});
it("handles month boundaries, missing days and chronological merging", async () => {
  const p = await setup();
  const logs = new Events(p.root, false, () => new Date("2026-11-01T00:00:00Z"));
  expect(logDates({ days: 3 }, new Date("2026-11-01T00:00:00Z"))).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
  expect(await logs.read()).toEqual([]);
});
it.each([
  { date: "2026-02-30" },
  { date: "bad" },
  { days: 0 },
  { days: -1 },
  { days: 1.5 },
  { date: "2026-10-21", days: 1 },
])("rejects invalid log selection %j", (selection) => {
  expect(() => logDates(selection)).toThrow();
});
it("moves a stale legacy lock mutex to run while preserving the persistent registry", async () => {
  const p = await setup();
  await atomic(p.legacy("locks/registry.json"), { holders: [], waiters: [] });
  await fs.writeFile(p.legacy("locks/.mutex"), "999999999");
  await migrateLegacy(p);
  expect(await fs.readFile(p.locksPid, "utf8")).toBe("999999999");
  expect(await exists(path.join(p.locksDirectory, ".mutex"))).toBe(false);
  expect(await exists(p.lockRegistry)).toBe(true);
});
