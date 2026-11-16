import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { HerdrRunner, HerdrWorkspace } from "../../src/adapters/herdr.js";
import { atomic } from "../../src/core/files.js";
import { Ownership } from "../../src/core/ownership.js";
import { initialState } from "../../src/core/state.js";
import type { ExecRequest, WorkspaceInfo } from "../../src/core/types.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { config, starts, harness, pr, temp } from "../helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function setup(options: Parameters<typeof harness>[0] = { stage: "修正中" }) {
  const h = await harness(options);
  dirs.push(h.dir);
  h.prs.set(1, [pr()]);
  // 承認を挟む引き継ぎを確かめる（WORKFLOW.md は auto で、tick ごとに自動で引き継ぐ）
  h.workflow.gates.adopt_workspace = "manual";
  return h;
}
const owner = { issue: 1, step: "verify" };
function humanWorkspace(dir: string): WorkspaceInfo {
  return {
    key: "human",
    path: path.join(dir, "copilot-1264-fix-layout"),
    branch: "branch-101",
    workspaceId: "w-human",
    slot: 3,
  };
}
function noWorkspaceChanges(h: Awaited<ReturnType<typeof setup>>) {
  expect(h.a.workspace.ensure).not.toHaveBeenCalled();
  expect(h.a.workspace.sync).not.toHaveBeenCalled();
  expect(h.a.workspace.remove).not.toHaveBeenCalled();
  expect(h.a.runner.start).not.toHaveBeenCalled();
  expect(h.a.runner.prompt).not.toHaveBeenCalled();
  expect(h.a.runner.stop).not.toHaveBeenCalled();
}

describe("verify start and worktree ownership", () => {
  it("keeps verify behind verify_start with the flow-verify name", async () => {
    const h = await setup();
    h.workflow.gates.verify_start = "manual";
    await h.o.tick();
    await h.make().tick();
    expect((await h.o.states.read(1))?.gate?.name).toBe("verify_start");
    noWorkspaceChanges(h);
    expect((await h.o.locks.list()).holders).toEqual([]);
    await h.o.control(1, "approve", { gate: "verify_start" });
    expect(h.a.runner.start).not.toHaveBeenCalled();
    await h.o.tick();
    expect(h.a.runner.start).toHaveBeenCalledWith(expect.objectContaining({ name: "flow-verify-1" }));
  });
  it("asks to adopt an existing human worktree without ports, sync, panes, or locks", async () => {
    const h = await setup();
    h.workspaces.push(humanWorkspace(h.dir));
    await h.o.tick();
    await h.make().tick();
    expect((await h.o.states.read(1))?.gate).toMatchObject({
      name: "adopt_workspace",
      phase: "adopt",
      workspace: { workspaceId: "w-human" },
    });
    noWorkspaceChanges(h);
    expect((await h.o.locks.list()).holders).toEqual([]);
    expect((await h.o.owned.read()).workspaces).toEqual([]);
  });
  it("adopts only after approval; a subsequent tick can use the exact workspace", async () => {
    const h = await setup();
    const ws = humanWorkspace(h.dir);
    h.workspaces.push(ws);
    await h.o.tick();
    await h.o.control(1, "approve", { gate: "adopt_workspace" });
    noWorkspaceChanges(h);
    const record = (await h.o.owned.read()).workspaces[0]!;
    expect(record).toMatchObject({
      ...owner,
      source: "adopted",
      path: ws.path,
      branch: ws.branch,
      workspaceId: ws.workspaceId,
    });
    expect(record.createdAt).toBeTruthy();
    await h.make().tick();
    expect(h.a.workspace.sync).toHaveBeenCalledTimes(1);
    expect(starts(h.a)).toHaveLength(1);
  });
  it("rejects adoption without stopping any human agent or removing the worktree", async () => {
    const h = await setup();
    h.workspaces.push(humanWorkspace(h.dir));
    await h.o.tick();
    await h.o.control(1, "reject", { gate: "adopt_workspace", reason: "人の作業中" });
    noWorkspaceChanges(h);
    expect((await h.o.states.read(1))?.status).toBe("stopped");
    expect((await h.o.owned.read()).workspaces).toEqual([]);
  });
  it("requires another confirmation if the workspace identity changes before adoption approval", async () => {
    const h = await setup();
    h.workspaces.push(humanWorkspace(h.dir));
    await h.o.tick();
    h.workspaces[0]!.workspaceId = "replacement";
    await expect(h.o.control(1, "approve")).rejects.toThrow("移動・変更");
    noWorkspaceChanges(h);
    expect((await h.o.owned.read()).workspaces).toEqual([]);
  });
  it.each([
    { status: "working", name: "manual" },
    { status: "blocked", name: "manual" },
    { status: "working", name: undefined },
    { status: "blocked", name: undefined },
  ] as const)("defers an owned workspace occupied by a foreign $status agent ($name)", async ({ status, name }) => {
    const h = await setup();
    const ws = humanWorkspace(h.dir);
    h.workspaces.push(ws);
    await h.o.owned.addWorkspace(ws, owner, "created");
    vi.mocked(h.a.runner.list).mockResolvedValue([{ name, paneId: "w-human:p2", workspaceId: ws.workspaceId, status }]);
    await h.o.tick();
    await h.make().tick();
    noWorkspaceChanges(h);
    expect(await h.o.states.read(1)).toMatchObject({ status: "idle", attempt: 0, history: [] });
    expect((await h.o.locks.list()).holders).toEqual([]);
  });
  it("does not claim a same-name idle agent based on its flow- prefix", async () => {
    const h = await setup();
    vi.mocked(h.a.runner.list).mockResolvedValue([
      { name: "flow-verify-1", paneId: "human:p1", workspaceId: "w-human", status: "idle" },
    ]);
    await h.o.tick();
    noWorkspaceChanges(h);
    expect((await h.o.states.read(1))?.history.at(-1)?.reason).toContain("所有物ではありません");
    expect((await h.o.owned.read()).agents).toEqual([]);
  });
  it("records newly created worktrees and started agents across an orchestrator restart", async () => {
    const h = await setup();
    await h.o.tick();
    const r = await new Ownership(h.dir).read();
    expect(r.workspaces[0]).toMatchObject({ ...owner, source: "created", branch: "branch-101" });
    expect(r.agents.find((a) => a.name === "flow-verify-1")).toMatchObject({ ...owner, paneId: "w1:p1" });
    await h.make().tick();
    expect(starts(h.a)).toHaveLength(1);
  });
  it("keeps an unowned slot occupied even though flow does not adopt its worktree", async () => {
    const h = await setup({ stage: "未着手" });
    const ws = humanWorkspace(h.dir);
    ws.branch = "unrelated";
    ws.slot = 1;
    h.workspaces.push(ws);
    await h.o.tick();
    expect((await h.o.states.read(1))?.workspace?.slot).toBe(2);
    expect((await h.o.owned.read()).workspaces.some((w) => w.path === ws.path)).toBe(false);
  });
  it("never seeds owned.json from legacy state references during cleanup", async () => {
    const h = await setup();
    const ws = humanWorkspace(h.dir);
    h.workspaces.push(ws);
    const state = initialState(1);
    state.step = "verify";
    state.workspaces = [ws];
    state.workspace = ws;
    state.agent = { runner: "herdr", name: "verify-3170", paneId: "human:p1" };
    await h.o.save(state);
    const merged = pr();
    merged.state = "merged";
    h.prs.set(1, [merged]);
    await h.o.tick();
    await h.o.control(1, "approve", { gate: "cleanup" });
    await h.o.tick();
    expect(h.a.workspace.remove).not.toHaveBeenCalled();
    expect(h.a.runner.stop).not.toHaveBeenCalled();
    expect(h.workspaces).toHaveLength(1);
  });
  it("cleanup removes owned worktrees and preserves additional human worktrees", async () => {
    const h = await setup();
    await h.o.tick();
    const foreign = humanWorkspace(h.dir);
    foreign.branch = "other";
    h.workspaces.push(foreign);
    const state = (await h.o.states.read(1))!;
    state.workspaces.push(foreign);
    await h.o.save(state);
    const merged = pr();
    merged.state = "merged";
    h.prs.set(1, [merged]);
    await h.o.tick();
    await h.o.control(1, "approve", { gate: "cleanup" });
    await h.o.tick();
    expect(h.a.workspace.remove).toHaveBeenCalledTimes(1);
    expect(h.a.runner.closeIssueTab).toHaveBeenCalledWith(1);
    expect(h.a.workspace.remove).not.toHaveBeenCalledWith(foreign);
    expect(h.workspaces).toEqual([foreign]);
    expect((await h.o.owned.read()).workspaces).toEqual([]);
  });
  it("does not stop an unowned agent referenced by state when explicitly stopped", async () => {
    const h = await setup();
    const s = initialState(1);
    s.step = "verify";
    s.status = "running";
    s.agent = { runner: "herdr", name: "flow-verify-1", paneId: "human:p1" };
    await h.o.save(s);
    await h.o.control(1, "stop");
    expect(h.a.runner.stop).not.toHaveBeenCalled();
    expect((await h.o.states.read(1))?.status).toBe("stopped");
  });
  it("does not request a missing result from an unowned agent referenced by running state", async () => {
    const h = await setup();
    const s = initialState(1);
    s.step = "verify";
    s.attempt = 1;
    s.status = "running";
    s.agent = { runner: "herdr", name: "verify-3170", paneId: "human:p1" };
    await h.o.save(s);
    vi.mocked(h.a.runner.status).mockResolvedValue("idle");
    await h.o.tick();
    expect(h.a.runner.prompt).not.toHaveBeenCalled();
    expect(h.a.runner.stop).not.toHaveBeenCalled();
    expect((await h.o.states.read(1))?.status).toBe("retry_wait");
  });
  it("does not persist ownership or plan operations in an unowned-worktree dry-run", async () => {
    const h = await setup({ stage: "修正中", dryRun: true });
    h.workspaces.push(humanWorkspace(h.dir));
    const rows = await h.o.tick();
    expect(rows[0]).toMatchObject({ status: "waiting_gate", gate: "adopt_workspace", agent: null });
    noWorkspaceChanges(h);
    await expect(fs.access(path.join(h.state, "owned.json"))).rejects.toThrow();
  });
});

describe("adapter enforcement at mutation boundaries", () => {
  async function adapters(rawAgents: unknown[] = []) {
    const dir = await temp();
    dirs.push(dir);
    const w = await config();
    w.vars.main = dir;
    const owned = new Ownership(path.join(dir, "run"));
    const ws = humanWorkspace(dir);
    const commands: ExecRequest[] = [];
    const exec = {
      run: vi.fn(async (r: ExecRequest) => {
        commands.push(r);
        if (r.command === "mise wt:list") return `${ws.workspaceId}\t${ws.slot}\t${ws.branch}\t${ws.path}`;
        if (r.command === "herdr agent list") return JSON.stringify({ result: { agents: rawAgents } });
        if (r.command.startsWith("herdr agent prompt"))
          rawAgents = rawAgents.map((a) => ({ ...(a as object), agent_status: "working" }));
        return "";
      }),
    };
    return {
      dir,
      w,
      owned,
      ws,
      commands,
      exec,
      workspace: new HerdrWorkspace(exec, w.workspace, w.vars, false, owned),
      runner: new HerdrRunner(exec, w.runner, dir, false, owned),
    };
  }
  it("refuses ensure/open, sync/ports, remove and start on an unowned worktree", async () => {
    const h = await adapters();
    h.ws.workspaceId = null;
    await expect(h.workspace.ensure({ key: "x", branch: h.ws.branch, owner })).rejects.toThrow("所有記録");
    await expect(h.workspace.sync(h.ws)).rejects.toThrow("所有記録");
    await expect(h.workspace.remove(h.ws)).rejects.toThrow("所有記録");
    await expect(h.runner.start({ name: "flow-verify-1", ws: h.ws, kind: "claude", owner })).rejects.toThrow(
      "所有記録",
    );
    expect(h.commands.filter((r) => r.mutation)).toEqual([]);
  });
  it("refuses start/prompt/stop for an unowned same-name idle agent, including a flow-prefixed name", async () => {
    const h = await adapters([
      { name: "flow-verify-1", pane_id: "human:p1", workspace_id: "w-human", agent_status: "idle" },
    ]);
    await h.owned.addWorkspace(h.ws, owner, "adopted");
    const handle = { runner: "herdr", name: "flow-verify-1", paneId: "human:p1" };
    await expect(h.runner.start({ name: handle.name, ws: h.ws, kind: "claude", owner })).rejects.toThrow(
      "所有物ではありません",
    );
    await expect(h.runner.prompt(handle, "test")).rejects.toThrow("所有記録");
    await expect(h.runner.stop(handle)).rejects.toThrow("所有記録");
    expect(h.commands.filter((r) => r.mutation)).toEqual([]);
  });
  it("also refuses legacy manual verify names", async () => {
    const h = await adapters([{ name: "verify-3170", pane_id: "human:p1", agent_status: "idle" }]);
    await h.owned.addWorkspace(h.ws, owner, "adopted");
    await expect(h.runner.start({ name: "verify-3170", ws: h.ws, kind: "claude", owner })).rejects.toThrow("agent 名");
    await expect(h.runner.prompt({ runner: "herdr", name: "verify-3170", paneId: "human:p1" }, "test")).rejects.toThrow(
      "所有記録",
    );
    expect(h.commands.filter((r) => r.mutation)).toEqual([]);
  });
  it("rejects a replaced pane occupant even if the name and pane ID match the record", async () => {
    const h = await adapters([
      {
        name: "flow-verify-1",
        pane_id: "human:p1",
        agent_status: "idle",
        agent_session: { value: "new-session" },
      },
    ]);
    await h.owned.addAgent(
      { runner: "herdr", name: "flow-verify-1", paneId: "human:p1", sessionId: "original-session" },
      owner,
      h.ws,
    );
    await expect(
      h.runner.prompt({ runner: "herdr", name: "flow-verify-1", paneId: "human:p1" }, "test"),
    ).rejects.toThrow("一致しません");
    expect(h.commands.filter((r) => r.mutation)).toEqual([]);
  });
  it("reuses an owned idle agent by its recorded pane without creating another pane", async () => {
    const h = await adapters([
      {
        name: "flow-verify-1",
        pane_id: "w-human:p2",
        workspace_id: "w-human",
        agent_status: "idle",
      },
    ]);
    await h.owned.addWorkspace(h.ws, owner, "created");
    await h.owned.addAgent({ runner: "herdr", name: "flow-verify-1", paneId: "w-human:p2" }, owner, h.ws);
    const result = await h.runner.start({
      name: "flow-verify-1",
      ws: h.ws,
      kind: "claude",
      owner,
    });
    expect(result.paneId).toBe("w-human:p2");
    expect(h.commands.filter((r) => r.mutation)).toEqual([]);
    expect(await h.runner.ready(result)).toBe("ready");
    await h.runner.prompt(result, "test");
    expect(h.commands.filter((r) => r.mutation).map((r) => r.command)).toEqual([
      "herdr agent prompt 'flow-verify-1' 'test'",
    ]);
    expect(h.commands.at(-1)?.command).toContain("herdr agent read");
  });
  it("refuses ports/sync/start/cleanup if an owned workspace becomes busy after scheduling", async () => {
    const h = await adapters([{ pane_id: "w-human:p3", workspace_id: "w-human", agent_status: "blocked" }]);
    await h.owned.addWorkspace(h.ws, owner, "created");
    await expect(h.workspace.sync(h.ws)).rejects.toThrow("使用中");
    await expect(h.workspace.remove(h.ws)).rejects.toThrow("使用中");
    await expect(h.runner.start({ name: "flow-verify-1", ws: h.ws, kind: "claude", owner })).rejects.toThrow("使用中");
    expect(h.commands.filter((r) => r.mutation)).toEqual([]);
  });
  it("fails closed when owned.json is corrupt", async () => {
    const h = await adapters();
    await atomic(h.owned.file, null);
    await expect(h.workspace.sync(h.ws)).rejects.toThrow("壊れています");
    expect(h.commands.filter((r) => r.mutation)).toEqual([]);
    expect(JSON.parse(await fs.readFile(h.owned.file, "utf8"))).toBeNull();
  });
});

it("validates the flow- agent prefix in WORKFLOW.md", async () => {
  const source = await fs.readFile(path.join(import.meta.dirname, "../fixtures/WORKFLOW.md"), "utf8");
  expect(() => parseWorkflow(source.replace(/name: ['"]flow-verify-\{issue\}['"]/, 'name: "verify-{issue}"'))).toThrow(
    "agent",
  );
});

it("records workspace creation before allowing ports or sync in the real adapter", async () => {
  const dir = await temp();
  dirs.push(dir);
  const w = await config();
  w.vars.main = dir;
  const owned = new Ownership(path.join(dir, "run"));
  const ws = {
    key: "new",
    path: path.join(dir, "new-wt"),
    workspaceId: "w-new",
    branch: "new-branch",
    slot: null,
  };
  const changes: string[] = [];
  let createdInHerdr = false;
  const exec = {
    run: vi.fn(async (r: ExecRequest) => {
      if (r.command === "mise wt:list") return createdInHerdr ? `${ws.workspaceId}\t-\t${ws.branch}\t${ws.path}` : "";
      if (r.command === "herdr agent list") return '{"result":{"agents":[]}}';
      if (r.command.startsWith("mise wt:create")) {
        createdInHerdr = true;
        return `worktree=${ws.path} workspace=${ws.workspaceId} pane=w-new:p1`;
      }
      if (r.mutation) {
        expect(await owned.workspace(ws)).toBeTruthy();
        changes.push(r.command);
      }
      return "";
    }),
  };
  const adapter = new HerdrWorkspace(exec, w.workspace, w.vars, false, owned);
  const created = await adapter.ensure({ key: ws.key, branch: ws.branch, owner });
  expect((await owned.read()).workspaces[0]).toMatchObject({
    ...owner,
    source: "created",
    path: ws.path,
  });
  created.slot = 2;
  await adapter.sync(created);
  expect(changes).toHaveLength(2);
  expect(changes[0]).toContain("mise wt:ports");
  expect(changes[1]).toContain("mise wt:sync");
});
it("records the newly started agent before delivering its first prompt in the real adapter", async () => {
  const dir = await temp();
  dirs.push(dir);
  const w = await config();
  const owned = new Ownership(path.join(dir, "run"));
  const ws = humanWorkspace(dir);
  await owned.addWorkspace(ws, owner, "created");
  let started = false;
  let submitted = false;
  const exec = {
    run: vi.fn(async (r: ExecRequest) => {
      if (r.command === "herdr agent list")
        return JSON.stringify({
          result: {
            agents: started
              ? [
                  {
                    name: "flow-verify-1",
                    pane_id: "w-human:p4",
                    workspace_id: "w-human",
                    agent_status: submitted ? "working" : "idle",
                    agent_session: { value: "created-session" },
                  },
                ]
              : [],
          },
        });
      if (r.command === "herdr workspace list")
        return JSON.stringify({
          result: { workspaces: [{ workspace_id: "w-main", worktree: { checkout_path: dir } }] },
        });
      if (r.command.startsWith("herdr tab create"))
        return '{"result":{"tab":{"tab_id":"w-human:t2"},"root_pane":{"pane_id":"w-human:p4"}}}';
      if (r.command.startsWith("herdr agent start")) started = true;
      if (r.command.startsWith("herdr agent prompt")) {
        submitted = true;
        expect((await owned.read()).agents[0]).toMatchObject({
          ...owner,
          name: "flow-verify-1",
          paneId: "w-human:p4",
          sessionId: "created-session",
        });
      }
      return "";
    }),
  };
  const adapter = new HerdrRunner(exec, w.runner, dir, false, owned);
  const handle = await adapter.start({
    name: "flow-verify-1",
    ws,
    kind: "claude",
    owner,
  });
  expect(handle.sessionId).toBe("created-session");
  expect(exec.run.mock.calls.filter(([r]) => r.command.startsWith("herdr agent prompt"))).toHaveLength(0);
  expect(await adapter.ready(handle)).toBe("ready");
  await adapter.prompt(handle, "test");
  expect(exec.run.mock.calls.filter(([r]) => r.command.startsWith("herdr agent prompt"))).toHaveLength(1);
});
it("does not turn an unnamed foreign agent into an owned agent merely because a pane matches", async () => {
  const dir = await temp();
  dirs.push(dir);
  const owned = new Ownership(dir);
  const ws = humanWorkspace(dir);
  await owned.addAgent({ runner: "herdr", name: "flow-verify-1", paneId: "w-human:p2" }, owner, ws);
  expect(await owned.foreignBusy(ws, [{ paneId: "w-human:p2", workspaceId: "w-human", status: "working" }])).toBe(true);
});
