import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { atomic } from "../src/core/files.js";
import { starts, harness, pr } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function setup(options: Parameters<typeof harness>[0] = {}) {
  const h = await harness(options);
  dirs.push(h.dir);
  return h;
}
describe("tick and durable state", () => {
  it("starts once across repeated ticks and a fresh orchestrator", async () => {
    const h = await setup();
    await h.o.tick();
    await h.make().tick();
    expect(starts(h.a)).toHaveLength(1);
    const s = await h.o.states.read(1);
    expect(s?.status).toBe("running");
    expect(s?.attempt).toBe(1);
    expect(s?.locks).toEqual(["slot:1", "db:shared"]);
  });
  it("gates a start, approval dispatches only on next tick", async () => {
    const h = await setup();
    h.workflow.gates.start = "manual";
    await h.o.tick();
    await h.o.tick();
    expect(h.a.runner.start).not.toHaveBeenCalled();
    expect(h.a.notifier.notify).toHaveBeenCalledTimes(1);
    await h.o.control(1, "approve", { gate: "start" });
    await h.o.tick();
    expect(starts(h.a)).toHaveLength(1);
  });
  it("checks results and artifacts, releases db but retains slot after gate", async () => {
    const h = await setup();
    await h.o.tick();
    vi.mocked(h.a.runner.status).mockResolvedValue("done");
    await h.result(1);
    for (const f of h.workflow.steps.repro!.done_when!.files!) await h.file(1, f);
    await h.o.tick();
    expect((await h.o.states.read(1))?.gate?.name).toBe("repro_result");
    expect((await h.o.locks.list()).holders.map((h) => h.resource)).toEqual(["slot:1"]);
    await h.o.control(1, "approve");
    expect(h.stages.get(1)).toBe("再現済");
    await h.o.tick();
    expect((await h.o.states.read(1))?.step).toBe("refine");
  });
  it("prompts once for missing result then retries with same workspace and reason", async () => {
    const h = await setup();
    await h.o.tick();
    const ws = (await h.o.states.read(1))?.workspace;
    vi.mocked(h.a.runner.status).mockResolvedValue("idle");
    await h.o.tick();
    await h.o.tick();
    expect(h.a.runner.prompt).toHaveBeenCalledTimes(2);
    expect((await h.o.states.read(1))?.status).toBe("retry_wait");
    h.advance(120001);
    await h.o.tick();
    const s = await h.o.states.read(1);
    expect(s?.attempt).toBe(2);
    expect(s?.workspace?.path).toBe(ws?.path);
    expect(vi.mocked(h.a.runner.prompt).mock.calls.at(-1)?.[1]).toContain("result.json がありません");
  });
  it("fails ok result when done_when missing, reaches retry cap, allows manual retry", async () => {
    const h = await setup();
    h.workflow.retry.max_attempts = 1;
    await h.o.tick();
    await h.result(1);
    vi.mocked(h.a.runner.status).mockResolvedValue("done");
    await h.o.tick();
    expect((await h.o.states.read(1))?.status).toBe("failed");
    await h.o.control(1, "retry");
    expect((await h.o.states.read(1))?.attempt).toBe(0);
  });
  it("does not restart a stalled agent while it is still working", async () => {
    const h = await setup();
    await h.o.tick();
    await h.o.tick();
    h.advance(h.workflow.stall_ms + 1);
    await h.o.tick();
    expect((await h.o.states.read(1))?.status).toBe("retry_wait");
    h.advance(120001);
    await h.o.tick();
    expect(starts(h.a)).toHaveLength(1);
    expect(h.a.runner.stop).not.toHaveBeenCalled();
    expect((await h.o.locks.list()).holders.map((l) => l.resource)).toContain("db:shared");
    vi.mocked(h.a.runner.status).mockResolvedValue("idle");
    await h.o.tick();
    expect(starts(h.a)).toHaveLength(2);
  });
  it("handles gone, questions and activity recovery", async () => {
    const h = await setup();
    await h.o.tick();
    vi.mocked(h.a.runner.status).mockResolvedValue("blocked");
    await h.o.tick();
    expect((await h.o.states.read(1))?.gate?.name).toBe("agent_question");
    await h.o.answer(1, "回答です");
    expect(vi.mocked(h.a.runner.prompt).mock.calls.at(-1)?.[1]).toBe("回答です");
    expect((await h.o.states.read(1))?.status).toBe("running");
    expect((await h.o.states.read(1))?.gate).toBeNull();
    vi.mocked(h.a.runner.status).mockResolvedValue("working");
    await h.o.tick();
    expect((await h.o.states.read(1))?.status).toBe("running");
    await expect(h.o.answer(1, "回答")).rejects.toThrow("質問待ちではありません");
    vi.mocked(h.a.runner.status).mockResolvedValue("gone");
    await h.o.tick();
    expect((await h.o.states.read(1))?.history.at(-1)?.reason).toContain("gone");
  });
  it("opens an owned issue tab when no agent exists", async () => {
    const h = await setup();
    await expect(h.o.open(1)).rejects.toThrow("タブがありません");
    await h.o.owned.addTab({
      issue: 1,
      workspaceId: "w",
      tabId: "t",
      paneId: "p",
      createdAt: new Date().toISOString(),
    });
    await h.o.open(1);
    expect(h.a.runner.focusTab).toHaveBeenCalledWith("t");
  });
  it("stops an unassigned running issue without removing its workspace", async () => {
    const h = await setup();
    await h.o.tick();
    h.candidates.splice(0);
    await h.o.tick();
    expect(vi.mocked(h.a.runner.stop).mock.calls.map(([a]) => a.name)).toEqual(["flow-repro-1"]);
    expect(h.a.workspace.remove).not.toHaveBeenCalled();
    expect((await h.o.states.read(1))?.status).toBe("stopped");
  });
  it("skips corrupt state rather than replacing it; continues other issues", async () => {
    const h = await setup({ count: 2 });
    await h.file(1, "flow/state.json");
    await h.o.tick();
    expect(await fs.readFile(path.join(h.files.get(1)!, "flow/state.json"), "utf8")).toBe("evidence");
    expect(starts(h.a)).toHaveLength(1);
    expect((await h.o.states.read(2))?.status).toBe("running");
  });
  it("isolates command failures and schedules other issues", async () => {
    const h = await setup({ count: 2 });
    vi.mocked(h.a.workspace.ensure).mockRejectedValueOnce(new Error("unavailable"));
    await h.o.tick();
    expect((await h.o.states.read(1))?.status).toBe("retry_wait");
    expect((await h.o.states.read(2))?.status).toBe("running");
    expect((await h.o.locks.list()).holders.filter((l) => l.issue === 1 && l.resource === "db:shared")).toHaveLength(0);
  });
  it("uses priority then creation date and enforces concurrency without retry", async () => {
    const h = await setup({ count: 3 });
    h.workflow.concurrency.global = 1;
    h.candidates[2]!.labels = ["priority:1"];
    await h.o.tick();
    expect((await h.o.states.read(3))?.status).toBe("running");
    expect((await h.o.states.read(1))?.status).toBe("idle");
    expect(starts(h.a)).toHaveLength(1);
  });
  it("keeps cleanup gate across ticks even for closed merged issue, deletes only on approval", async () => {
    const h = await setup();
    await h.o.tick();
    const p = pr();
    p.state = "merged";
    h.prs.set(1, [p]);
    h.candidates[0]!.state = "closed";
    await h.o.tick();
    await h.o.tick();
    expect((await h.o.states.read(1))?.gate?.name).toBe("cleanup");
    expect(h.a.workspace.remove).not.toHaveBeenCalled();
    await h.o.control(1, "approve");
    await h.o.tick();
    expect(h.a.workspace.remove).toHaveBeenCalledTimes(1);
    expect((await h.o.states.read(1))?.status).toBe("done");
  });
  it("never assigns a remote agent if an open Copilot PR already exists", async () => {
    const h = await setup({ stage: "Issue更新済" });
    h.prs.set(1, [pr()]);
    await h.o.tick();
    expect((await h.o.states.read(1))?.status).toBe("waiting_remote");
    expect(vi.mocked(h.a.exec.run).mock.calls.filter(([r]) => r.mutation)).toHaveLength(0);
  });
  it("performs assign once after approval; polls to change stage", async () => {
    const h = await setup({ stage: "Issue更新済" });
    await h.o.tick();
    await h.o.control(1, "approve");
    await h.o.tick();
    await h.o.tick();
    expect(vi.mocked(h.a.exec.run).mock.calls.filter(([r]) => r.mutation)).toHaveLength(1);
    h.prs.set(1, [pr()]);
    const remote = h.a.remote(h.workflow.steps.implement!);
    vi.mocked(h.a.remote).mockReturnValue({
      prepare: (...args) => remote.prepare(...args),
      request: vi.fn(),
      poll: vi.fn(async () => "done" as const),
    });
    await h.o.tick();
    expect(h.stages.get(1)).toBe("修正中");
    expect((await h.o.states.read(1))?.step).toBe("verify");
  });
  it("continues approved finish with a new result and does not repeat prompt", async () => {
    const h = await setup({ stage: "検証済" });
    h.prs.set(1, [pr()]);
    await h.o.tick();
    await h.o.control(1, "approve", { gate: "finish_start" });
    await h.o.tick();
    await h.file(1, "pr-body.md");
    await h.result(1);
    vi.mocked(h.a.runner.status).mockResolvedValue("done");
    await h.o.tick();
    await h.o.control(1, "approve");
    expect(h.a.runner.prompt).toHaveBeenCalledTimes(2);
    expect(await h.o.states.result((await h.o.states.read(1))!)).toBeNull();
    await h.result(1);
    await h.o.tick();
    await h.o.tick();
    expect((await h.o.states.read(1))?.status).toBe("done");
    expect(h.a.runner.prompt).toHaveBeenCalledTimes(2);
  });
  it("routes verify NG through an explicit choice, sends drafted comment once", async () => {
    const h = await setup({ stage: "修正中" });
    h.prs.set(1, [pr()]);
    await h.o.tick();
    await h.file(1, "ng-comment.md");
    for (const f of h.workflow.steps.verify!.done_when!.files!) await h.file(1, f);
    h.stages.set(1, "検証NG");
    await h.result(1, "ng");
    vi.mocked(h.a.runner.status).mockResolvedValue("done");
    await h.o.tick();
    expect((await h.o.states.read(1))?.gate?.name).toBe("ng_action");
    await expect(h.o.control(1, "approve")).rejects.toThrow("choice");
    await h.o.control(1, "approve", { choice: "copilot" });
    expect((await h.o.states.read(1))?.status).toBe("waiting_remote");
    expect(vi.mocked(h.a.exec.run).mock.calls.filter(([r]) => r.mutation)).toHaveLength(1);
  });
  it("reject and stop retain worktree and record reasons", async () => {
    const h = await setup();
    h.workflow.gates.start = "manual";
    await h.o.tick();
    await h.o.control(1, "reject", { reason: "要確認" });
    expect((await h.o.states.read(1))?.history.at(-1)?.reason).toBe("要確認");
    expect((await h.o.states.read(1))?.status).toBe("stopped");
  });
  it("holds uncertain public command for recovery rather than repeating it", async () => {
    const h = await setup({ stage: "Issue更新済" });
    h.workflow.gates.assign = "auto";
    vi.mocked(h.a.exec.run).mockImplementation(async (r) => {
      if (!r.mutation) return "main";
      throw new Error("connection lost");
    });
    await h.o.tick();
    await h.o.tick();
    expect(vi.mocked(h.a.exec.run).mock.calls.filter(([r]) => r.mutation)).toHaveLength(1);
    expect((await h.o.states.read(1))?.gate?.name).toBe("operation_recovery");
    await h.o.control(1, "approve", { choice: "applied" });
    await h.o.tick();
    expect(vi.mocked(h.a.exec.run).mock.calls.filter(([r]) => r.mutation)).toHaveLength(1);
  });
  it("recovers an interrupted launch without a duplicate start", async () => {
    const h = await setup();
    await h.o.tick();
    const s = (await h.o.states.read(1))!;
    s.launchPending = true;
    await h.o.save(s);
    await h.make().tick();
    expect((await h.o.states.read(1))?.gate?.name).toBe("launch_recovery");
    expect(starts(h.a)).toHaveLength(1);
  });
  it("does not touch state.json or lock files in a dry tick", async () => {
    const h = await setup({ dryRun: true });
    await h.o.tick();
    await expect(fs.access(path.join(h.files.get(1)!, "flow/state.json"))).rejects.toThrow();
    await expect(fs.access(path.join(h.state, "locks/registry.json"))).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(path.join(h.run, "last-plan.json"), "utf8"))[0].planned).toBe(true);
  });
});

describe("approval and recovery edge cases", () => {
  it("skips a skippable step at its start gate without launching an agent, a worktree or a mutation", async () => {
    const h = await setup({ stage: "検証済" });
    h.prs.set(1, [pr()]);
    await h.o.tick();
    expect((await h.o.states.read(1))?.gate?.name).toBe("finish_start");
    await h.o.control(1, "approve", { gate: "finish_start", choice: "skip" });
    const skipped = await h.o.states.read(1);
    expect(skipped).toMatchObject({ status: "idle", gate: null, completed: ["finish"] });
    expect(skipped?.history.at(-1)).toMatchObject({ step: "finish", result: "skipped" });
    await h.o.tick();
    expect((await h.o.states.read(1))?.status).toBe("done");
    expect(h.stages.get(1)).toBe("検証済");
    expect(h.a.runner.start).not.toHaveBeenCalled();
    expect(h.a.workspace.ensure).not.toHaveBeenCalled();
    expect(vi.mocked(h.a.exec.run).mock.calls.filter(([r]) => r.mutation)).toHaveLength(0);
  });
  it("adopts a worktree opened outside flow on the PR branch and forgets it once removed", async () => {
    const h = await setup({ stage: "検証済" });
    h.prs.set(1, [pr()]);
    const main = { key: "main", branch: "main", path: h.dir, workspaceId: "w0", slot: null };
    const external = { key: "ext", branch: "branch-101", path: path.join(h.dir, "ext"), workspaceId: "w9", slot: 2 };
    h.workspaces.push(main, external);
    await h.o.tick();
    const adopted = await h.o.states.read(1);
    expect(adopted?.workspaces.map((w) => w.path)).toEqual([external.path]);
    expect(adopted?.locks).toContain("slot:2");
    expect((await h.o.owned.read()).workspaces).toMatchObject([{ path: external.path, issue: 1, source: "adopted" }]);
    expect((await h.o.rows([adopted!], [])).at(0)?.slot).toBe(2);
    h.workspaces.splice(h.workspaces.indexOf(external), 1);
    await h.o.tick();
    const forgotten = await h.o.states.read(1);
    expect(forgotten?.workspaces).toEqual([]);
    expect((await h.o.locks.list()).holders.filter((l) => l.issue === 1 && l.resource.startsWith("slot:"))).toEqual([]);
    expect((await h.o.owned.read()).workspaces).toEqual([]);
  });
  it("moves a done finish to cleanup after the merge and keeps the worktree with --choice keep", async () => {
    const h = await setup({ stage: "検証済" });
    h.prs.set(1, [pr()]);
    const main = { key: "main", branch: "main", path: h.dir, workspaceId: "w0", slot: null };
    const external = { key: "ext", branch: "branch-101", path: path.join(h.dir, "ext"), workspaceId: "w9", slot: 2 };
    h.workspaces.push(main, external);
    await h.o.tick();
    await h.o.control(1, "approve", { gate: "finish_start", choice: "skip" });
    await h.o.tick();
    expect((await h.o.states.read(1))?.status).toBe("done");
    await expect(h.o.control(1, "approve", { choice: "keep" })).rejects.toThrow("該当する gate");
    h.prs.set(1, [{ ...pr(), state: "merged" }]);
    await h.o.tick();
    expect((await h.o.states.read(1))?.gate?.name).toBe("cleanup");
    await h.o.control(1, "approve", { gate: "cleanup", choice: "keep" });
    await h.o.tick();
    const cleaned = await h.o.states.read(1);
    expect(cleaned).toMatchObject({ status: "done", workspaces: [] });
    expect(cleaned?.completed).toContain("cleanup");
    expect(h.a.workspace.remove).not.toHaveBeenCalled();
    expect(h.workspaces).toContain(external);
    expect((await h.o.locks.list()).holders.filter((l) => l.issue === 1)).toEqual([]);
    expect((await h.o.owned.read()).workspaces).toEqual([]);
  });
  it("rejects keep for a start gate of a step that does not remove worktrees", async () => {
    const h = await setup({ stage: "検証済" });
    h.prs.set(1, [pr()]);
    await h.o.tick();
    await expect(h.o.control(1, "approve", { gate: "finish_start", choice: "keep" })).rejects.toThrow("cleanup");
    expect((await h.o.states.read(1))?.gate?.name).toBe("finish_start");
  });
  it("rejects skip for a start gate whose step is not skippable", async () => {
    const h = await setup({ stage: "Issue更新済" });
    await h.o.tick();
    await expect(h.o.control(1, "approve", { choice: "skip" })).rejects.toThrow("skippable");
    expect((await h.o.states.read(1))?.gate?.name).toBe("assign");
  });
  it("requires manual DB approval for each exclusive acquisition and preserves running state", async () => {
    const h = await setup();
    h.workflow.gates.db_reset = "manual";
    await h.o.tick();
    await h.o.locks.queue("db:exclusive", 1);
    expect(await h.o.acquireResource("db:exclusive", 1)).toBe(false);
    expect((await h.o.states.read(1))?.gate?.name).toBe("db_reset");
    await h.o.control(1, "approve", { gate: "db_reset" });
    expect((await h.o.states.read(1))?.status).toBe("running");
    expect(await h.o.acquireResource("db:exclusive", 1)).toBe(true);
    await h.o.releaseResource("db:exclusive", 1);
    expect((await h.o.locks.list()).holders.map((l) => l.resource)).toContain("db:shared");
    expect(await h.o.acquireResource("db:exclusive", 1)).toBe(false);
  });
  it("honors an explicit auto NG choice without creating a gate", async () => {
    const h = await setup({ stage: "修正中" });
    h.workflow.gates.ng_action = "auto";
    h.workflow.remote!.ng_action!.choice = "copilot";
    h.prs.set(1, [pr()]);
    await h.o.tick();
    await h.file(1, "evidence/after/checks.tsv");
    await h.file(1, "ng-comment.md");
    h.stages.set(1, "検証NG");
    await h.result(1, "ng");
    vi.mocked(h.a.runner.status).mockResolvedValue("done");
    await h.o.tick();
    expect((await h.o.states.read(1))?.status).toBe("waiting_remote");
    expect((await h.o.states.read(1))?.gate).toBeNull();
    expect(vi.mocked(h.a.exec.run).mock.calls.filter(([r]) => r.mutation)).toHaveLength(1);
  });
  it("keeps the gate when NG comment draft is missing", async () => {
    const h = await setup({ stage: "修正中" });
    h.prs.set(1, [pr()]);
    await h.o.tick();
    await h.file(1, "evidence/after/checks.tsv");
    h.stages.set(1, "検証NG");
    await h.result(1, "ng");
    vi.mocked(h.a.runner.status).mockResolvedValue("done");
    await h.o.tick();
    await expect(h.o.control(1, "approve", { choice: "copilot" })).rejects.toThrow("ng-comment");
    expect((await h.o.states.read(1))?.gate?.name).toBe("ng_action");
  });
  it("resumes a confirmed NG post without repeating it or moving its time boundary", async () => {
    const h = await setup({ stage: "修正中" });
    h.prs.set(1, [pr()]);
    await h.o.tick();
    await h.file(1, "evidence/after/checks.tsv");
    await h.file(1, "ng-comment.md");
    h.stages.set(1, "検証NG");
    await h.result(1, "ng");
    vi.mocked(h.a.runner.status).mockResolvedValue("done");
    await h.o.tick();
    vi.mocked(h.a.exec.run).mockImplementation(async (r) => {
      if (r.mutation) throw new Error("unknown completion");
      return "main";
    });
    await h.o.control(1, "approve", { choice: "copilot" });
    const since = (await h.o.states.read(1))?.remoteSince;
    h.advance(240000);
    await h.o.control(1, "approve", { choice: "applied" });
    expect((await h.o.states.read(1))?.status).toBe("waiting_remote");
    expect((await h.o.states.read(1))?.remoteSince).toBe(since);
    expect(vi.mocked(h.a.exec.run).mock.calls.filter(([r]) => r.mutation)).toHaveLength(1);
  });
  it("resumes an after-gate approval persisted before its action", async () => {
    const h = await setup({ stage: "再現済" });
    await h.o.tick();
    await h.file(1, "issue.md");
    await h.result(1);
    vi.mocked(h.a.runner.status).mockResolvedValue("done");
    await h.o.tick();
    const s = (await h.o.states.read(1))!;
    s.approvedGate = { ...s.gate! };
    s.approvals.push(`${s.step}:${s.attempt}:after:issue_push`);
    s.gate = null;
    s.status = "idle";
    await h.o.save(s);
    await h.make().tick();
    expect(vi.mocked(h.a.exec.run).mock.calls.filter(([r]) => r.mutation)).toHaveLength(1);
    expect((await h.o.states.read(1))?.status).toBe("done");
  });
  it("enforces completion conditions for ng as well as ok", async () => {
    const h = await setup();
    await h.o.tick();
    await h.result(1, "ng");
    vi.mocked(h.a.runner.status).mockResolvedValue("done");
    await h.o.tick();
    expect((await h.o.states.read(1))?.status).toBe("retry_wait");
    expect((await h.o.states.read(1))?.history.at(-1)?.reason).toContain("done_when");
  });
  it("reports stage-store failures without preventing other issues from starting", async () => {
    const h = await setup({ count: 2 });
    vi.mocked(h.a.stages.get).mockImplementation(async (n) => {
      if (n === 1) throw new Error("stage unavailable");
      return h.stages.get(n) ?? null;
    });
    const rows = await h.o.tick();
    expect(rows.find((r) => r.issue === 1)?.error).toContain("stage unavailable");
    expect((await h.o.states.read(2))?.status).toBe("running");
  });
  it("clears DB reservations after a capped failure once the original agent settles", async () => {
    const h = await setup();
    h.workflow.retry.max_attempts = 1;
    await h.o.tick();
    await h.o.tick();
    h.advance(h.workflow.stall_ms + 1);
    await h.o.tick();
    expect((await h.o.states.read(1))?.status).toBe("failed");
    expect((await h.o.locks.list()).holders.map((l) => l.resource)).toContain("db:shared");
    vi.mocked(h.a.runner.status).mockResolvedValue("idle");
    await h.o.tick();
    expect((await h.o.locks.list()).holders.map((l) => l.resource)).not.toContain("db:shared");
    expect((await h.o.states.read(1))?.status).toBe("failed");
  });
});

it("skips JSON null state rather than treating it as an absent state", async () => {
  const h = await setup({ count: 2 });
  await atomic(path.join(h.files.get(1)!, "flow/state.json"), null);
  await h.o.tick();
  expect(starts(h.a)).toHaveLength(1);
  expect(JSON.parse(await fs.readFile(path.join(h.files.get(1)!, "flow/state.json"), "utf8"))).toBeNull();
});
it("rejects JSON null result without prompting as though it were missing", async () => {
  const h = await setup();
  await h.o.tick();
  const s = (await h.o.states.read(1))!;
  await atomic(path.join(h.files.get(1)!, `flow/result-${s.step}-${s.attempt}.json`), null);
  vi.mocked(h.a.runner.status).mockResolvedValue("done");
  await h.o.tick();
  expect((await h.o.states.read(1))?.status).toBe("retry_wait");
  expect(h.a.runner.prompt).toHaveBeenCalledTimes(1); // Initial prompt only; no result reminder.
});
it("can retry a confirmed unsubmitted continuation prompt exactly once", async () => {
  const h = await setup({ stage: "検証済" });
  h.prs.set(1, [pr()]);
  await h.o.tick();
  await h.o.control(1, "approve", { gate: "finish_start" });
  await h.o.tick();
  await h.file(1, "pr-body.md");
  await h.result(1);
  vi.mocked(h.a.runner.status).mockResolvedValue("done");
  await h.o.tick();
  vi.mocked(h.a.runner.prompt).mockRejectedValueOnce(new Error("not submitted"));
  await expect(h.o.control(1, "approve")).rejects.toThrow("not submitted");
  await h.o.tick();
  expect((await h.o.states.read(1))?.gate?.name).toBe("operation_recovery");
  await h.o.control(1, "approve", { choice: "retry" });
  expect((await h.o.states.read(1))?.status).toBe("running");
  expect(h.a.runner.prompt).toHaveBeenCalledTimes(3);
});

it("requires finish_start before acquiring locks, creating workspaces or starting an agent", async () => {
  const h = await setup({ stage: "検証済" });
  h.prs.set(1, [pr()]);
  await h.o.tick();
  await h.make().tick();
  const waiting = (await h.o.states.read(1))!;
  expect(waiting.status).toBe("waiting_gate");
  expect(waiting.gate?.name).toBe("finish_start");
  expect(waiting.attempt).toBe(0);
  expect(waiting.agent).toBeNull();
  expect(h.a.workspace.ensure).not.toHaveBeenCalled();
  expect(h.a.workspace.sync).not.toHaveBeenCalled();
  expect(h.a.runner.start).not.toHaveBeenCalled();
  expect(h.a.runner.prompt).not.toHaveBeenCalled();
  expect((await h.o.locks.list()).holders).toEqual([]);
  await h.o.control(1, "approve", { gate: "finish_start" });
  expect(h.a.runner.start).not.toHaveBeenCalled();
  await h.o.tick();
  expect(starts(h.a)).toHaveLength(1);
  expect((await h.o.states.read(1))?.status).toBe("running");
});
it("uses a configured finish gate name rather than a hard-coded name", async () => {
  const h = await setup({ stage: "検証済" });
  h.prs.set(1, [pr()]);
  h.workflow.steps.finish!.gate_before = "custom_finish_gate";
  h.workflow.gates.custom_finish_gate = "manual";
  delete h.workflow.gates.finish_start;
  await h.o.tick();
  expect((await h.o.states.read(1))?.gate?.name).toBe("custom_finish_gate");
  expect(h.a.runner.start).not.toHaveBeenCalled();
  await h.o.control(1, "approve", { gate: "custom_finish_gate" });
  await h.o.tick();
  expect(starts(h.a)).toHaveLength(1);
});
it("plans only finish_start approval and no agent/workspace mutations in a dry tick", async () => {
  const h = await setup({ stage: "検証済", dryRun: true });
  h.prs.set(1, [pr()]);
  const rows = await h.o.tick();
  expect(rows[0]).toMatchObject({
    step: "finish",
    status: "waiting_gate",
    gate: "finish_start",
    agent: null,
    slot: null,
  });
  expect(h.a.workspace.ensure).not.toHaveBeenCalled();
  expect(h.a.runner.start).not.toHaveBeenCalled();
  expect(h.a.runner.prompt).not.toHaveBeenCalled();
  expect(vi.mocked(h.a.exec.run).mock.calls.filter(([r]) => r.mutation)).toHaveLength(0);
});
describe("step agent placement", () => {
  it("starts one worktree agent with the step prompt", async () => {
    const h = await setup();
    await h.o.tick();
    expect(vi.mocked(h.a.runner.start).mock.calls.map(([spec]) => [spec.name, spec.place, spec.ws.key])).toEqual([
      ["flow-repro-1", "worktree", "repro-1"],
    ]);
    expect(vi.mocked(h.a.runner.prompt).mock.calls[0]?.[1]).toContain("Issue を再現してください");
    const s = await h.o.states.read(1);
    expect(s?.agent?.name).toBe("flow-repro-1");
    expect(s?.worker).toBeUndefined();
  });
  it("starts a main agent for a step without a worktree", async () => {
    const h = await setup({ stage: "再現済" });
    await h.o.tick();
    expect(vi.mocked(h.a.runner.start).mock.calls.map(([spec]) => [spec.name, spec.place])).toEqual([
      ["flow-refine-1", "main"],
    ]);
  });
});

describe("refine worktree cleanup", () => {
  it.each([false, true])("removes the repro workspace or retains it when dirty (dirty=%s)", async (dirty) => {
    const h = await setup();
    await h.o.tick();
    vi.mocked(h.a.runner.status).mockResolvedValue("done");
    await h.result(1);
    for (const f of h.workflow.steps.repro!.done_when!.files!) await h.file(1, f);
    await h.o.tick();
    await h.o.control(1, "approve");
    await h.o.tick();
    await h.file(1, "issue.md");
    await h.result(1);
    await h.o.tick();
    if (dirty) {
      const { WorkspaceDirtyError } = await import("../src/core/ownership.js");
      vi.mocked(h.a.workspace.remove).mockRejectedValueOnce(new WorkspaceDirtyError("未コミット"));
    }
    await h.o.control(1, "approve");
    const s = (await h.o.states.read(1))!;
    expect(s.status).toBe("idle");
    expect(s.completed).toContain("refine");
    expect(h.workspaces).toHaveLength(dirty ? 1 : 0);
    expect(s.locks.includes("slot:1")).toBe(dirty);
    expect((await h.o.owned.read()).workspaces).toHaveLength(dirty ? 1 : 0);
    if (dirty)
      expect(h.a.notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: "worktree を削除できませんでした" }),
      );
  });
  it("closes an owned worker in legacy state", async () => {
    const h = await setup();
    await h.o.tick();
    const s = (await h.o.states.read(1))!;
    const worker = { runner: "herdr", name: "flow-repro-1-wt", paneId: "w1:p2", keepTab: true };
    await h.o.owned.addAgent(worker, { issue: 1, step: "repro" }, s.workspace!);
    s.worker = worker;
    await h.o.closeCompleted(s);
    expect(h.a.runner.close).toHaveBeenCalledWith(worker);
    expect(s.worker).toBeNull();
  });
});

describe("reviewed cleanup and issue tab safety", () => {
  it.each(["remove", "close", "ownership"])("continues a completed transition when %s fails", async (failure) => {
    const h = await setup();
    await h.o.tick();
    const s = (await h.o.states.read(1))!;
    const ws = s.workspace!;
    s.step = "refine";
    s.agent = null;
    if (failure === "remove") vi.mocked(h.a.workspace.remove).mockRejectedValue(new Error("remove unavailable"));
    if (failure === "ownership") vi.spyOn(h.o.owned, "workspace").mockRejectedValue(new Error("ownership unavailable"));
    if (failure === "close") {
      const worker = { runner: "herdr", name: "flow-old-1", paneId: "w1:p9", keepTab: true };
      await h.o.owned.addAgent(worker, { issue: 1, step: "repro" }, ws);
      vi.mocked(h.a.runner.close).mockRejectedValue(new Error("exit timeout"));
    }
    await h.o.transition(s, { remove_workspaces: ["flow/repro-{issue}"] });
    expect(s.status).toBe("idle");
    expect(s.completed).toContain("refine");
    expect(h.workspaces).toHaveLength(1);
    expect(s.locks).toContain("slot:1");
    expect(h.a.notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "worktree を削除できませんでした", level: "action" }),
    );
    await expect(h.o.removeWorkspaces(s)).rejects.toThrow();
  });
  it("notifies once while the issue tab remains busy, and again after recovery", async () => {
    const { IssueTabBusyError } = await import("../src/core/ownership.js");
    const h = await setup({ stage: "再現済" });
    vi.mocked(h.a.runner.start)
      .mockRejectedValueOnce(new IssueTabBusyError("occupied"))
      .mockRejectedValueOnce(new IssueTabBusyError("occupied"));
    await h.o.tick();
    await h.make().tick();
    const notifications = () =>
      vi.mocked(h.a.notifier.notify).mock.calls.filter(([n]) => n.title === "Issue のタブが使用中です");
    expect(notifications()).toHaveLength(1);
    expect((await h.o.states.read(1))?.issueTabBusy).toBe(true);
    await h.o.tick();
    const s = (await h.o.states.read(1))!;
    expect(s.issueTabBusy).toBeUndefined();
    expect(s.status).toBe("running");
    s.status = "idle";
    s.agent = null;
    await h.o.save(s);
    vi.mocked(h.a.runner.start).mockRejectedValueOnce(new IssueTabBusyError("occupied again"));
    await h.o.tick();
    expect(notifications()).toHaveLength(2);
  });
  it("closes the issue tab when an unassigned issue is stopped by reconciliation", async () => {
    const h = await setup({ stage: "再現済" });
    await h.o.tick();
    h.candidates.splice(0);
    await h.o.tick();
    expect(h.a.runner.closeIssueTab).toHaveBeenCalledWith(1);
    expect((await h.o.states.read(1))?.status).toBe("stopped");
  });
  it.each(["reject", "cleanup"])("forgets an unverifiable tab and notifies during %s", async (action) => {
    const { OwnershipError } = await import("../src/core/ownership.js");
    const h = await setup();
    await h.o.owned.addTab({ issue: 1, workspaceId: "main", tabId: "tab", paneId: "pane", createdAt: "now" });
    vi.mocked(h.a.runner.closeIssueTab).mockRejectedValue(new OwnershipError("identity mismatch"));
    if (action === "reject") await h.o.control(1, "reject");
    else {
      await h.o.tick();
      const merged = pr();
      merged.state = "merged";
      h.prs.set(1, [merged]);
      await h.o.tick();
      await h.o.control(1, "approve", { gate: "cleanup" });
      await h.o.tick();
      expect((await h.o.states.read(1))?.status).toBe("done");
    }
    expect(await h.o.owned.tab(1)).toBeUndefined();
    expect(h.a.notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Issue のタブを閉じませんでした",
        body: expect.stringContaining("所有を確認できない"),
      }),
    );
  });
});
