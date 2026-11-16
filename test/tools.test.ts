import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vite-plus/test";

import { createProgram } from "../src/cli/commands.js";
import type { CliServices } from "../src/cli/runtime.js";
import { packageRoot, selfPath, tools } from "../src/cli/tools.js";
import { FlowPaths } from "../src/core/paths.js";
import { readCursor, scan } from "../src/core/watch.js";
import { temp } from "./helpers.js";

const root = path.resolve(import.meta.dirname, "..");

async function fixture() {
  const dir = await temp();
  const runTool = vi.fn(async () => 0);
  const services: CliServices = {
    paths: new FlowPaths(dir),
    open: vi.fn(async () => {
      throw new Error("tools must not open the workflow");
    }),
    output: vi.fn(),
    error: vi.fn(),
    sleep: vi.fn(async () => {}),
    now: vi.fn(() => 0),
    runTool,
  };
  const program = createProgram(services);
  return { dir, services, runTool, run: (args: string[]) => program.parseAsync(args, { from: "user" }) };
}

describe("flow issue / flow wt", () => {
  it("bundles a script for every command, and every script parses", async () => {
    for (const [group, entries] of Object.entries(tools))
      for (const name of Object.keys(entries)) {
        const file = path.join(root, "tools", group, name);
        await expect(fs.access(file)).resolves.toBeUndefined();
        await promisify(execFile)("bash", ["-n", file]);
      }
    for (const lib of ["issue.sh", "wt.sh"])
      await promisify(execFile)("bash", ["-n", path.join(root, "tools/lib", lib)]);
  });
  it("passes arguments and flags as mise-style usage variables without opening the workflow", async () => {
    const f = await fixture();
    await f.run(["wt", "create", "feature/x", "--no-hooks"]);
    await f.run(["wt", "ports", "../wt", "--slot", "2"]);
    await f.run(["wt", "remove", "w3", "--yes"]);
    await f.run(["issue", "dir", "3170"]);
    const calls = f.runTool.mock.calls as unknown as [string, Record<string, string>][];
    expect(calls.map(([script]) => path.relative(root, script))).toEqual([
      "tools/wt/create",
      "tools/wt/ports",
      "tools/wt/remove",
      "tools/issue/dir",
    ]);
    expect(calls[0]![1]).toMatchObject({ usage_branch: "feature/x", usage_no_hooks: "true" });
    expect(calls[1]![1]).toMatchObject({ usage_path: "../wt", usage_slot: "2" });
    expect(calls[2]![1]).toMatchObject({ usage_workspace: "w3", usage_yes: "true" });
    expect(calls[2]![1]).not.toHaveProperty("usage_no_hooks");
    expect(calls[3]![1]).toMatchObject({ usage_number: "3170", FLOW_NODE: process.execPath });
    expect(calls[3]![1]).not.toHaveProperty("usage_create");
    expect(f.services.open).not.toHaveBeenCalled();
  });
  it("returns the script's exit code", async () => {
    const f = await fixture();
    f.runTool.mockResolvedValueOnce(3);
    const before = process.exitCode;
    await f.run(["issue", "mark", "1", "完了"]);
    expect(process.exitCode).toBe(3);
    process.exitCode = before;
  });
  it("finds the package and puts its bin and this Node first on PATH, once", () => {
    expect(packageRoot(path.join(root, "dist"))).toBe(root);
    const value = selfPath({ PATH: `/usr/bin:${path.join(root, "bin")}` }, root, "/opt/node/bin/node");
    expect(value.split(":")).toEqual([path.join(root, "bin"), "/opt/node/bin", "/usr/bin"]);
  });
});

describe("flow watch", () => {
  const event = (e: string, extra: object = {}) =>
    JSON.stringify({ at: "2026-11-12T00:00:00Z", issue: 1, step: "repro", event: e, message: "m", ...extra }) + "\n";
  it("primes to the end, then returns only new actionable production events", async () => {
    const f = await fixture();
    const log = path.join(f.services.paths.logs, "2026-11-12/events.ndjson");
    await fs.mkdir(path.dirname(log), { recursive: true });
    await fs.writeFile(log, event("action"));
    await f.run(["watch", "--prime"]);
    expect(f.services.output).toHaveBeenLastCalledWith(JSON.stringify({ initialized: true, events: [] }));
    await fs.appendFile(log, event("tick") + event("action", { dryRun: true }) + event("error"));
    await f.run(["watch", "--timeout", "5"]);
    const out = JSON.parse(vi.mocked(f.services.output).mock.lastCall![0] as string);
    expect(out.initialized).toBe(false);
    expect(out.events.map((e: { event: string }) => e.event)).toEqual(["error"]);
  });
  it("initializes on first use and times out with no events", async () => {
    const f = await fixture();
    await f.run(["watch"]);
    expect(f.services.output).toHaveBeenLastCalledWith(JSON.stringify({ initialized: true, events: [] }));
    let now = 0;
    vi.mocked(f.services.now).mockImplementation(() => now);
    vi.mocked(f.services.sleep).mockImplementation(async (ms) => {
      now += ms;
    });
    await f.run(["watch", "--timeout", "3"]);
    expect(f.services.output).toHaveBeenLastCalledWith(JSON.stringify({ initialized: false, events: [] }));
    expect(f.services.sleep).toHaveBeenCalled();
  });
  it("re-reads a partial line, and restarts a replaced or truncated file", async () => {
    const dir = await temp();
    const log = path.join(dir, "2026-11-12/events.ndjson");
    await fs.mkdir(path.dirname(log), { recursive: true });
    await fs.writeFile(log, event("action").slice(0, 20));
    let r = await scan(dir, {});
    expect(r.events).toEqual([]);
    expect(r.cursor["2026-11-12/events.ndjson"]!.offset).toBe(0);
    await fs.writeFile(log, event("action"));
    r = await scan(dir, r.cursor);
    expect(r.events).toHaveLength(1);
    // A replacement made by rename gets a new inode while the old file still exists.
    await fs.writeFile(`${log}.new`, event("warning"));
    await fs.rename(`${log}.new`, log);
    r = await scan(dir, r.cursor);
    expect(r.events.map((e) => e.event)).toEqual(["warning"]);
    await fs.truncate(log, 0);
    await fs.appendFile(log, event("tick_error"));
    expect(
      (
        await scan(dir, {
          ...r.cursor,
          "2026-11-12/events.ndjson": { ...r.cursor["2026-11-12/events.ndjson"]!, offset: 10_000 },
        })
      ).events,
    ).toHaveLength(1);
    await expect(scan(dir, {}).then(() => readCursor(path.join(dir, "none.json")))).resolves.toBeNull();
  });
  it("refuses a second watcher", async () => {
    const f = await fixture();
    await fs.mkdir(f.services.paths.run, { recursive: true });
    await fs.writeFile(`${f.services.paths.watchCursor}.pid`, String(process.pid));
    await expect(f.run(["watch", "--prime"])).rejects.toThrow("別の flow watch が動いています");
  });
});
