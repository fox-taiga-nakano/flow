import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { atomic } from "../src/core/files.js";
import { FlowPaths } from "../src/core/paths.js";
import { parseWorkflow } from "../src/core/workflow.js";
import type { DbResetRequest } from "../src/types.js";
import { harness, pr } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function setup(options: Parameters<typeof harness>[0] = {}) {
  const h = await harness(options);
  dirs.push(h.dir);
  if (options.stage === "修正中") h.prs.set(1, [pr()]);
  await h.o.tick();
  const paused = new Set<number>();
  vi.mocked(h.a.runner.status).mockImplementation(async (agent) =>
    [...paused].some(
      (n) =>
        agent.name === `flow-${options.stage === "修正中" ? "verify" : "repro"}-${n}` ||
        agent.name === `flow-${options.stage === "修正中" ? "verify" : "repro"}-${n}-wt`,
    )
      ? "done"
      : "working",
  );
  const request = async (n = 1, change: Partial<DbResetRequest> = {}) => {
    const s = (await h.o.states.read(n))!;
    paused.add(n);
    await atomic(FlowPaths.result(h.files.get(n)!, s.step, s.attempt), {
      result: "blocked",
      summary: "DB の前提データがない",
      needs: "flow のリセット待ち",
      artifacts: [],
      db_reset: { id: "reset-1", mode: "snapshot", reason: "前提データがない", ...change },
    });
  };
  const resets = () =>
    vi
      .mocked(h.a.exec.run)
      .mock.calls.map(([r]) => r)
      .filter((r) => r.command.includes("mise db:reset"));
  return { ...h, paused, request, resets };
}

describe("flow-owned DB reset", () => {
  it.each(["未着手", "修正中"])(
    "resets only on request, in the owned worktree, and resumes the same attempt (%s)",
    async (stage) => {
      const h = await setup({ stage });
      expect(h.resets()).toEqual([]);
      await h.request();
      await h.o.tick();
      expect(h.resets()).toHaveLength(1);
      const s = (await h.o.states.read(1))!;
      expect(h.resets()[0]).toMatchObject({ cwd: s.workspace!.path, mutation: true });
      expect(h.resets()[0]!.command).toContain("--snapshot");
      const mutations = vi
        .mocked(h.a.exec.run)
        .mock.calls.map(([r]) => r)
        .filter((r) => r.mutation);
      expect(mutations.map((r) => r.command)).toEqual([h.workflow.database!.stop, h.resets()[0]!.command]);
      expect(s).toMatchObject({ status: "running", gate: null, attempt: 1 });
      expect(s.dbReset).toBeUndefined();
      expect(s.continuation).toBeUndefined();
      expect(s.locks).toContain("db:shared");
      expect(s.locks).not.toContain("db:exclusive");
      expect(h.a.runner.prompt).toHaveBeenLastCalledWith(s.agent, expect.stringContaining("正常に完了"));
      expect(await fs.readFile(FlowPaths.result(h.files.get(1)!, s.step, 1, ".db-reset-reset-1"), "utf8")).toContain(
        "db_reset",
      );
      await h.make().tick();
      expect(h.resets()).toHaveLength(1);
      const events = await h.o.events.read(1);
      expect(events.filter((e) => e.event === "db_reset")).toHaveLength(1);
    },
  );

  it("keeps the normal completion gate after resuming repro", async () => {
    const h = await setup();
    await h.request();
    await h.o.tick();
    await h.result(1);
    for (const file of h.workflow.steps.repro!.done_when!.files!) await h.file(1, file);
    await h.o.tick();
    expect((await h.o.states.read(1))?.gate?.name).toBe("repro_result");
  });

  it("requires manual db_reset approval once for each request", async () => {
    const h = await setup();
    h.workflow.gates.db_reset = "manual";
    await h.request();
    await h.o.tick();
    expect((await h.o.states.read(1))?.gate).toMatchObject({ name: "db_reset", phase: "db" });
    expect(h.resets()).toEqual([]);
    await h.o.control(1, "approve", { gate: "db_reset" });
    await h.make().tick();
    expect(h.resets()).toHaveLength(1);
    await h.request(1, { id: "reset-2", mode: "seed" });
    await h.o.tick();
    expect((await h.o.states.read(1))?.gate?.name).toBe("db_reset");
    expect(h.resets()).toHaveLength(1);
    await h.o.control(1, "approve", { gate: "db_reset" });
    await h.o.tick();
    expect(h.resets()[1]!.command).toContain("--seed");
  });

  it("waits across ticks for other readers without blocking tick or letting new readers in", async () => {
    const h = await setup({ count: 2 });
    await h.request();
    await h.o.tick();
    expect(h.resets()).toEqual([]);
    expect(await h.o.locks.acquire(["db:shared"], 3)).toBeNull();
    expect((await h.o.locks.list()).holders.filter((l) => l.resource === "db:shared").map((l) => l.issue)).toEqual([2]);
    await h.o.locks.release(2);
    await h.make().tick();
    expect(h.resets()).toHaveLength(1);
    expect((await h.o.states.read(1))?.dbReset).toBeUndefined();
  });

  it("serializes simultaneous reset requests and protects the resumed reader from the next writer", async () => {
    const h = await setup({ count: 2 });
    await h.request(1);
    await h.request(2);
    await h.o.tick();
    expect(h.resets()).toHaveLength(1);
    expect((await h.o.states.read(2))?.locks).toContain("db:shared");
    await h.o.tick();
    expect(h.resets()).toHaveLength(1);
    await h.o.locks.release(2);
    await h.make().tick();
    expect(h.resets()).toHaveLength(2);
  });

  it("never resets while the agent is working or blocked", async () => {
    const h = await setup();
    h.workflow.gates.db_reset = "manual";
    await h.request();
    await h.o.tick();
    await h.o.control(1, "approve", { gate: "db_reset" });
    for (const status of ["working", "blocked"] as const) {
      vi.mocked(h.a.runner.status).mockResolvedValue(status);
      await h.o.tick();
      expect(h.resets()).toEqual([]);
    }
    vi.mocked(h.a.runner.status).mockResolvedValue("done");
    await h.o.tick();
    expect(h.resets()).toHaveLength(1);
  });

  it.each(["mise wt:stop", "mise db:reset"])(
    "keeps the exclusive lock and does not resume after %s fails",
    async (failedCommand) => {
      const h = await setup();
      const prompts = vi.mocked(h.a.runner.prompt).mock.calls.length;
      vi.mocked(h.a.exec.run).mockImplementation(async (r) => {
        if (r.command.includes(failedCommand)) throw new Error("reset unavailable");
        return r.mutation ? "" : "main";
      });
      await h.request();
      await h.o.tick();
      const s = (await h.o.states.read(1))!;
      expect(s.gate?.name).toBe("operation_recovery");
      expect(s.locks).toContain("db:exclusive");
      expect(s.inflight?.key).toContain(":db-reset:");
      expect(vi.mocked(h.a.runner.prompt).mock.calls).toHaveLength(prompts);
      const calls = h.resets().length;
      await h.make().tick();
      expect(h.resets()).toHaveLength(calls);
      await expect(h.o.control(1, "stop")).rejects.toThrow("operation_recovery");
      if (failedCommand === "mise wt:stop") expect(h.resets()).toEqual([]);
    },
  );

  it.each(["applied", "retry"])(
    "recovers an uncertain reset with explicit %s without restarting the agent",
    async (choice) => {
      const h = await setup();
      vi.mocked(h.a.exec.run).mockImplementation(async (r) => {
        if (r.command.includes("mise db:reset")) throw new Error("uncertain");
        return r.mutation ? "" : "main";
      });
      await h.request();
      await h.o.tick();
      vi.mocked(h.a.exec.run).mockImplementation(async (r) => (r.mutation ? "" : "main"));
      await h.o.control(1, "approve", { gate: "operation_recovery", choice });
      await h.make().tick();
      expect(h.resets()).toHaveLength(choice === "applied" ? 1 : 2);
      expect(h.a.runner.start).toHaveBeenCalledTimes(1);
      expect((await h.o.states.read(1))?.dbReset).toBeUndefined();
      expect((await h.o.states.read(1))?.status).toBe("running");
    },
  );

  it("never repeats reset when resuming the agent fails", async () => {
    const h = await setup();
    vi.mocked(h.a.runner.prompt).mockRejectedValue(new Error("delivery uncertain"));
    await h.request();
    await h.o.tick();
    expect((await h.o.states.read(1))?.gate?.name).toBe("operation_recovery");
    expect((await h.o.states.read(1))?.locks).toContain("db:shared");
    await h.o.control(1, "approve", { gate: "operation_recovery", choice: "applied" });
    await h.make().tick();
    expect(h.resets()).toHaveLength(1);
    expect((await h.o.states.read(1))?.dbReset).toBeUndefined();
  });

  it("does not mutate state, locks, result files or execute a reset in dry-run", async () => {
    const h = await setup();
    await h.request();
    const s = (await h.o.states.read(1))!;
    const files = [
      FlowPaths.issueState(h.files.get(1)!),
      h.o.paths.lockRegistry,
      FlowPaths.result(h.files.get(1)!, s.step, 1),
    ];
    const before = await Promise.all(files.map((file) => fs.readFile(file, "utf8")));
    const { Orchestrator } = await import("../src/core/orchestrator.js");
    const dry = new Orchestrator(h.workflow, h.a, h.dir, true, () => {});
    await dry.tick();
    expect(await Promise.all(files.map((file) => fs.readFile(file, "utf8")))).toEqual(before);
    expect(h.resets()).toEqual([]);
  });

  it("rejects a request after the worktree identity changes", async () => {
    const h = await setup();
    await h.request();
    h.workspaces[0]!.branch = "someone-else";
    await h.o.tick();
    expect(h.resets()).toEqual([]);
  });

  it("waits while a foreign agent is using the worktree", async () => {
    const h = await setup();
    const s = (await h.o.states.read(1))!;
    vi.mocked(h.a.runner.list).mockResolvedValue([
      {
        name: "human",
        paneId: "human:p2",
        workspaceId: s.workspace!.workspaceId,
        status: "working",
      },
    ]);
    await h.request();
    await h.o.tick();
    expect(h.resets()).toEqual([]);
    vi.mocked(h.a.runner.list).mockResolvedValue([]);
    await h.o.tick();
    expect(h.resets()).toHaveLength(1);
  });

  it("cancels a queued request on stop, without resetting or leaving a writer waiter", async () => {
    const h = await setup({ count: 2 });
    await h.request();
    await h.o.tick();
    expect((await h.o.locks.list()).waiters).toHaveLength(1);
    await h.o.control(1, "stop");
    expect((await h.o.locks.list()).waiters).toEqual([]);
    expect((await h.o.states.read(1))?.dbReset).toBeUndefined();
    await h.o.locks.release(2);
    await h.o.tick();
    expect(h.resets()).toEqual([]);
  });

  it("rejects an already executed request ID", async () => {
    const h = await setup();
    await h.request();
    await h.o.tick();
    await h.request();
    await h.o.tick();
    expect(h.resets()).toHaveLength(1);
    expect((await h.o.states.read(1))?.status).toBe("retry_wait");
  });

  it.each([{ mode: "anything" }, { id: "../../escape" }, { reason: " " }])(
    "rejects malformed reset requests: %j",
    async (change) => {
      const h = await setup();
      await h.request(1, change as Partial<DbResetRequest>);
      await h.o.tick();
      expect(h.resets()).toEqual([]);
      expect((await h.o.states.read(1))?.status).toBe("retry_wait");
    },
  );

  it("rejects a reset request from an unconfigured step", async () => {
    const h = await setup();
    delete h.workflow.steps.repro!.db_reset;
    await h.request();
    await h.o.tick();
    expect(h.resets()).toEqual([]);
    expect((await h.o.states.read(1))?.status).toBe("retry_wait");
  });
});

describe("DB reset configuration", () => {
  it.each([
    ["    db_reset: true", "    db_reset: invalid"],
    ['  stop: "mise wt:stop"', '  stop: ""'],
    ['locks: [slot, "db:shared"]', "locks: [slot]"],
    ["  db_reset: auto", ""],
  ])("rejects invalid configuration (%s)", async (oldValue, newValue) => {
    const source = await fs.readFile(path.resolve(import.meta.dirname, "../test/fixtures/WORKFLOW.md"), "utf8");
    expect(() => parseWorkflow(source.replace(oldValue, newValue))).toThrow(/db_reset|database/);
  });
});
