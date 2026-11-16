import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { atomic } from "../../src/core/files.js";
import { initialState } from "../../src/core/state.js";
import { harness, pr } from "../helpers.js";

const dirs: string[] = [];
async function setup(options: Parameters<typeof harness>[0] = {}) {
  const h = await harness(options);
  dirs.push(h.dir);
  return h;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe("retry and elapsed time", () => {
  it("uses backoff[0] for the first retry and caps subsequent waits at the last value", async () => {
    const h = await setup();
    h.workflow.retry.max_attempts = 7;
    const s = initialState(1, "2026-10-21T01:00:00Z");
    for (const delay of [60000, 120000, 240000, 240000, 240000]) {
      await h.o.fail(s, "failure");
      expect(Date.parse(s.nextRetryAt!) - Date.parse(s.updatedAt)).toBe(delay);
    }
  });
  it("counts elapsed from step start even when an unrelated field is saved", async () => {
    const h = await setup();
    await h.o.tick();
    h.advance(30000);
    const s = (await h.o.states.read(1))!;
    s.resultReminder = true;
    await h.o.save(s);
    expect((await h.o.rows([s], h.candidates))[0]?.elapsed).toBe(30);
  });
  it("counts an unstarted gate from statusChangedAt, updating it only on a status change", async () => {
    const h = await setup();
    h.workflow.gates.start = "manual";
    await h.o.tick();
    const s = (await h.o.states.read(1))!;
    const since = s.statusChangedAt;
    h.advance(9000);
    s.resultReminder = true;
    await h.o.save(s);
    expect(s.statusChangedAt).toBe(since);
    expect((await h.o.rows([s], h.candidates))[0]?.elapsed).toBe(9);
    s.status = "idle";
    s.gate = null;
    await h.o.save(s);
    expect(s.statusChangedAt).toBe(s.updatedAt);
    expect((await h.o.rows([s], h.candidates))[0]?.elapsed).toBe(0);
  });
  it("clears the previous step start when the next step waits for approval", async () => {
    const h = await setup();
    await h.o.tick();
    const s = (await h.o.states.read(1))!;
    h.stages.set(1, "検証済");
    h.prs.set(1, [pr()]);
    s.status = "idle";
    s.gate = null;
    await h.o.save(s);
    h.advance(12000);
    await h.o.dispatch(s, h.candidates[0]!, [s]);
    expect(s.step).toBe("finish");
    expect(s.startedAt).toBeNull();
    expect((await h.o.rows([s], h.candidates))[0]?.elapsed).toBe(0);
  });
});

it("uses the legacy gate start rather than updatedAt without rewriting the old state", async () => {
  const h = await setup();
  h.workflow.gates.start = "manual";
  const s = initialState(1, "2026-10-21T01:00:00Z");
  delete s.statusChangedAt;
  s.step = "repro";
  s.status = "waiting_gate";
  s.gate = { name: "start", phase: "before", since: "2026-10-21T00:59:00Z", summary: "wait", artifacts: [] };
  const file = path.join(h.files.get(1)!, "flow/state.json");
  await atomic(file, s);
  const before = await fs.readFile(file, "utf8");
  expect((await h.o.tick())[0]?.elapsed).toBe(60);
  expect(await fs.readFile(file, "utf8")).toBe(before);
});
