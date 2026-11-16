import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { DirsStageStore } from "../src/adapters/dirs.js";
import { ShellExec } from "../src/adapters/exec.js";
import { parseAgents, parseWorkspaces } from "../src/adapters/herdr.js";
import { CommandError } from "../src/core/command-error.js";
import { atomic } from "../src/core/files.js";
import { initialState } from "../src/core/state.js";
import { parseWorkflow } from "../src/core/workflow.js";
import type { ExecRequest, Status } from "../src/types.js";
import { starts, harness, pr } from "./helpers.js";

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

describe("invalid external lists are isolated", () => {
  it("skips detached/malformed worktrees and malformed agents with a warning per row", () => {
    const warn = vi.fn();
    expect(
      parseWorkspaces("w1\t1\tmain\t/project\nw2\t2\t\t/detached\nbad\nw3\t-\tfeature\t/project/feature", warn).map(
        (w) => w.branch,
      ),
    ).toEqual(["main", "feature"]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(
      parseAgents(
        JSON.stringify({ result: { agents: [null, { name: "bad" }, { pane_id: "p", agent_status: "idle" }] } }),
        warn,
      ),
    ).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(4);
  });
  it("continues processing other Issues when the initial workspace list fails, without reclaiming locks", async () => {
    const h = await setup({ count: 2 });
    vi.mocked(h.a.workspace.list).mockRejectedValueOnce(new Error("workspace unavailable"));
    const reclaim = vi.spyOn(h.o.locks, "reclaim");
    const rows = await h.o.tick();
    expect(reclaim).not.toHaveBeenCalled();
    expect(rows).toHaveLength(2);
    expect(starts(h.a)).toHaveLength(2);
    expect((await h.o.events.read()).some((e) => e.message.includes("workspace unavailable"))).toBe(true);
  });
});
describe("directory cache and unchanged states", () => {
  it("caches paths/stages within a tick, refreshes after moves and at the next tick", async () => {
    const h = await setup();
    let dir = "/project/1-未着手_1";
    const e = {
      run: vi.fn(async (r: ExecRequest) => {
        if (r.command.includes("issue:mark")) dir = "/project/0-対象外_1";
        return dir;
      }),
    };
    const store = new DirsStageStore(e, h.workflow.stage_store, h.workflow.vars);
    store.beginTick();
    await store.ensure(1);
    await store.dir(1);
    expect(await store.get(1)).toBe("未着手");
    expect(e.run).toHaveBeenCalledTimes(1);
    await store.set(1, "対象外");
    expect(await store.dir(1)).toBe("/project/0-対象外_1");
    expect(await store.get(1)).toBe("対象外");
    expect(e.run).toHaveBeenCalledTimes(3);
    dir = "/project/7-未着手_1";
    store.beginTick();
    expect(await store.get(1)).toBe("未着手");
    expect(e.run).toHaveBeenCalledTimes(4);
  });
  it("does not rewrite state, updatedAt, or the Issue index on an unchanged waiting tick", async () => {
    const h = await setup();
    h.workflow.gates.start = "manual";
    await h.o.tick();
    const file = path.join(h.files.get(1)!, "flow/state.json");
    const index = path.join(h.state, "issues.json");
    const content = await fs.readFile(file, "utf8");
    const before = await fs.stat(file);
    const indexBefore = await fs.stat(index);
    h.advance(10000);
    await h.make().tick();
    expect(await fs.readFile(file, "utf8")).toBe(content);
    expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect((await fs.stat(index)).mtimeMs).toBe(indexBefore.mtimeMs);
  });
  it("writes issues.json once after multiple new Issues and reads it once", async () => {
    const h = await setup({ count: 3 });
    h.workflow.gates.start = "manual";
    const rename = vi.spyOn(fs, "rename");
    const read = vi.spyOn(fs, "readFile");
    await h.o.tick();
    const index = path.join(h.state, "issues.json");
    expect(rename.mock.calls.filter(([, to]) => to === index)).toHaveLength(1);
    expect(read.mock.calls.filter(([file]) => file === index)).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(index, "utf8"))).toEqual([1, 2, 3]);
  });
  it("does not rewrite a running state when the agent output remains unchanged", async () => {
    const h = await setup();
    await h.o.tick();
    await h.o.tick();
    const file = path.join(h.files.get(1)!, "flow/state.json");
    const before = await fs.readFile(file, "utf8");
    h.advance(1000);
    await h.make().tick();
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });
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
describe("initial prompt readiness and pane completion", () => {
  it.each(["blocked", "pending"] as const)(
    "does not send while %s and sends exactly once after readiness across restarts",
    async (ready) => {
      const h = await setup();
      vi.mocked(h.a.runner.ready).mockResolvedValue(ready);
      await h.o.tick();
      await h.make().tick();
      expect(h.a.runner.prompt).not.toHaveBeenCalled();
      expect(h.a.runner.close).not.toHaveBeenCalled();
      const waiting = (await h.o.states.read(1))!;
      expect(waiting.initialPrompt).toContain("Issue: #1");
      if (ready === "blocked") expect(waiting.gate?.name).toBe("agent_question");
      vi.mocked(h.a.runner.ready).mockResolvedValue("ready");
      await h.make().tick();
      await h.make().tick();
      expect(starts(h.a)).toHaveLength(1);
      expect(h.a.runner.prompt).toHaveBeenCalledTimes(1);
      expect((await h.o.states.read(1))?.initialPrompt).toBeUndefined();
    },
  );
  it.each(["applied", "retry"])(
    "recovers an uncertain initial prompt with %s without starting twice",
    async (choice) => {
      const h = await setup();
      vi.mocked(h.a.runner.prompt).mockRejectedValueOnce(new Error("delivery unknown"));
      await h.o.tick();
      expect((await h.o.states.read(1))?.gate?.name).toBe("operation_recovery");
      await h.make().tick();
      expect(h.a.runner.prompt).toHaveBeenCalledTimes(1);
      await h.make().control(1, "approve", { choice });
      await h.make().tick();
      await h.make().tick();
      expect(starts(h.a)).toHaveLength(1);
      expect(h.a.runner.prompt).toHaveBeenCalledTimes(choice === "applied" ? 1 : 2);
    },
  );
  it("keeps after-gate and question panes, then closes only after transition", async () => {
    const h = await setup();
    await h.o.tick();
    vi.mocked(h.a.runner.status).mockResolvedValue("blocked");
    await h.o.tick();
    expect(h.a.runner.close).not.toHaveBeenCalled();
    vi.mocked(h.a.runner.status).mockResolvedValue("done");
    const s = (await h.o.states.read(1))!;
    s.gate = null;
    s.status = "running";
    await h.o.save(s);
    await h.result(1);
    for (const f of h.workflow.steps.repro!.done_when!.files!) await h.file(1, f);
    await h.o.tick();
    expect(h.a.runner.close).not.toHaveBeenCalled();
    await h.o.control(1, "approve");
    expect(vi.mocked(h.a.runner.close).mock.calls.map(([a]) => a.name)).toEqual(["flow-repro-1"]);
    expect((await h.o.owned.read()).agents).toHaveLength(0);
  });
  it("keeps finish alive through approval and continuation, closes after its final result", async () => {
    const h = await setup({ stage: "検証済" });
    h.prs.set(1, [pr()]);
    await h.o.tick();
    await h.o.control(1, "approve");
    await h.o.tick();
    await h.file(1, "pr-body.md");
    await h.result(1);
    vi.mocked(h.a.runner.status).mockResolvedValue("done");
    await h.o.tick();
    await h.o.control(1, "approve");
    expect(h.a.runner.close).not.toHaveBeenCalled();
    await h.result(1);
    await h.o.tick();
    expect(vi.mocked(h.a.runner.close).mock.calls.map(([a]) => a.name)).toEqual(["flow-finish-1"]);
  });
  it("honors close_on_complete false and refuses to close unowned agents", async () => {
    const h = await setup();
    await h.o.tick();
    const s = (await h.o.states.read(1))!;
    h.workflow.runner.close_on_complete = false;
    await h.o.transition(s, { stop: true });
    expect(h.a.runner.close).not.toHaveBeenCalled();
    h.workflow.runner.close_on_complete = true;
    s.agent = { runner: "herdr", name: "human", paneId: "human:p1" };
    s.worker = { runner: "herdr", name: "human-wt", paneId: "human:p2" };
    await h.o.transition(s, { stop: true });
    expect(h.a.runner.close).not.toHaveBeenCalled();
  });
  it("defaults close_on_complete to true and validates its type", async () => {
    const source = await fs.readFile(path.resolve(import.meta.dirname, "../test/fixtures/WORKFLOW.md"), "utf8");
    expect(parseWorkflow(source.replace("  close_on_complete: true\n", "")).runner.close_on_complete).toBe(true);
    expect(() => parseWorkflow(source.replace("close_on_complete: true", "close_on_complete: nope"))).toThrow(
      "close_on_complete",
    );
  });
});
describe("reject without a gate", () => {
  it.each(["retry_wait", "failed", "stopped", "idle", "done", "waiting_remote"] as Status[])(
    "rejects %s without a gate and retry restores the original stage",
    async (status) => {
      const h = await setup({ stage: "修正中" });
      const s = initialState(1);
      s.status = status;
      await h.o.save(s);
      await h.o.control(1, "reject", { reason: "対象外" });
      expect(h.stages.get(1)).toBe("対象外");
      expect((await h.o.states.read(1))?.history.at(-1)?.reason).toBe("対象外");
      await h.o.control(1, "retry");
      expect(h.stages.get(1)).toBe("修正中");
    },
  );
  it("rejects an unregistered Issue without a gate, and ensures its directory", async () => {
    const h = await setup();
    h.stages.delete(1);
    await h.o.control(1, "reject");
    expect(h.a.runner.closeIssueTab).toHaveBeenCalledWith(1);
    expect(h.a.stages.ensure).toHaveBeenCalledWith(1);
    expect(h.stages.get(1)).toBe("対象外");
  });
  it("still refuses an explicit nonexistent gate", async () => {
    const h = await setup();
    await h.o.save(initialState(1));
    await expect(h.o.control(1, "reject", { gate: "start" })).rejects.toThrow("gate");
    expect(h.a.stages.set).not.toHaveBeenCalled();
  });
  it("stops a running owned agent before marking the Issue rejected", async () => {
    const h = await setup();
    await h.o.tick();
    vi.mocked(h.a.stages.set).mockImplementation(async (n, s) => {
      expect(h.a.runner.stop).toHaveBeenCalledTimes(1);
      h.stages.set(n, s);
    });
    await h.o.control(1, "reject");
    expect(h.stages.get(1)).toBe("対象外");
    expect(vi.mocked(h.a.runner.close).mock.calls.map(([a]) => a.name)).toEqual(["flow-repro-1"]);
  });
});
describe("external command diagnostics", () => {
  it("includes exit code and only the stderr tail", async () => {
    const exec = new ShellExec();
    let failure: CommandError | undefined;
    try {
      await exec.run({ command: "for ((i=1;i<=60;i++)); do echo line-$i >&2; done; exit 13", mutation: false });
    } catch (e) {
      failure = e as CommandError;
    }
    expect(failure).toBeInstanceOf(CommandError);
    expect(failure!.details).toMatchObject({ exitCode: 13, signal: null, timedOut: false });
    expect(failure!.details.stderr.split("\n")).toHaveLength(40);
    expect(String(failure)).toContain("line-60");
    expect(String(failure)).not.toContain("line-20\n");
  });
  it("records termination signals and distinguishes a timeout", async () => {
    const exec = new ShellExec();
    await expect(exec.run({ command: "kill -TERM $$", mutation: false })).rejects.toMatchObject({
      details: { signal: "SIGTERM", timedOut: false },
    });
    await expect(exec.run({ command: "exec /bin/sleep 1", mutation: false, timeoutMs: 20 })).rejects.toMatchObject({
      details: { signal: "SIGTERM", timedOut: true },
    });
  });
  it("persists structured command failure details in events and the Issue history", async () => {
    const h = await setup();
    const error = new CommandError(
      "mise issue:dir 4005",
      Object.assign(new Error("failed"), { code: 7, stderr: "specific failure", signal: "SIGTERM", killed: true }),
    );
    vi.mocked(h.a.workspace.ensure).mockRejectedValueOnce(error);
    await h.o.tick();
    expect((await h.o.states.read(1))?.history.at(-1)?.reason).toContain("specific failure");
    expect((await h.o.events.read()).find((e) => e.event === "command_error")?.commandFailure).toMatchObject({
      exitCode: 7,
      stderr: "specific failure",
      signal: "SIGTERM",
      timedOut: true,
    });
  });
});

it("records stderr when the initial directory lookup fails, without preventing the next Issue", async () => {
  const h = await setup({ count: 2 });
  const error = new CommandError(
    "mise issue:dir 1",
    Object.assign(new Error("failed"), { code: 4, stderr: "directory command failure" }),
  );
  vi.mocked(h.a.stages.ensure).mockRejectedValueOnce(error);
  await h.o.tick();
  expect(starts(h.a)).toHaveLength(1);
  expect((await h.o.events.read(1)).find((e) => e.event === "command_error")?.commandFailure?.stderr).toBe(
    "directory command failure",
  );
});
it("records command diagnostics for a failed reject even without a state file", async () => {
  const h = await setup();
  const error = new CommandError(
    "mise issue:dir 1",
    Object.assign(new Error("failed"), { code: 8, stderr: "permission denied" }),
  );
  vi.mocked(h.a.stages.get).mockRejectedValueOnce(error);
  await expect(h.o.control(1, "reject")).rejects.toThrow("permission denied");
  expect((await h.o.events.read(1)).find((e) => e.event === "command_error")?.commandFailure?.exitCode).toBe(8);
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
