import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { GraphQLAssignment, RestAssignment } from "../src/adapters/assignment.js";
import { CopilotRemote } from "../src/adapters/copilot.js";
import { ShellExec } from "../src/adapters/exec.js";
import { initialState } from "../src/core/state.js";
import { config, harness, pr } from "./helpers.js";

const dirs: string[] = [];
const setup = async (options: Parameters<typeof harness>[0] = {}) => {
  const h = await harness(options);
  dirs.push(h.dir);
  return h;
};
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
const mutations = (h: Awaited<ReturnType<typeof setup>>) =>
  vi.mocked(h.a.exec.run).mock.calls.filter(([r]) => r.mutation);
async function frozen() {
  const h = await setup({ stage: "Issue更新済" });
  const s = initialState(1);
  s.step = "implement";
  s.status = "waiting_remote";
  s.base = "main";
  await h.o.save(s);
  h.prs.set(1, [pr()]);
  return h;
}
it("resolves first line once per tick, uses current base for repro without freezing it", async () => {
  const h = await setup({ count: 2 });
  vi.mocked(h.a.exec.run).mockResolvedValue("release/next\nignored");
  await h.o.tick();
  expect(vi.mocked(h.a.exec.run).mock.calls.filter(([r]) => !r.mutation)).toHaveLength(1);
  expect(h.a.workspace.ensure).toHaveBeenCalledWith(expect.objectContaining({ base: "origin/release/next" }));
  expect((await h.o.states.read(1))?.base).toBeUndefined();
});
it.each(["", "error"])("base resolve %s defers allocation and reports an error once", async (output) => {
  const h = await setup({ count: 2 });
  vi.mocked(h.a.exec.run).mockImplementation(async () => {
    if (output === "error") throw new Error("git unavailable");
    return "";
  });
  await h.o.tick();
  expect(h.a.runner.start).not.toHaveBeenCalled();
  expect(h.a.workspace.ensure).not.toHaveBeenCalled();
  expect(h.a.notifier.notify).toHaveBeenCalledWith(
    expect.objectContaining({ level: "error", title: "base.resolve に失敗" }),
  );
  expect(h.a.exec.run).toHaveBeenCalledTimes(1);
  expect((await h.o.states.read(1))?.attempt).toBe(0);
});
it("resolves again after manual assign approval and freezes only the assigned base", async () => {
  const h = await setup({ stage: "Issue更新済" });
  await h.o.tick();
  expect((await h.o.states.read(1))?.base).toBeUndefined();
  await h.o.control(1, "approve");
  vi.mocked(h.a.exec.run).mockImplementation(async (r) => (r.mutation ? "" : "release/new"));
  await h.o.tick();
  expect((await h.o.states.read(1))?.base).toBe("release/new");
  expect(mutations(h)).toHaveLength(1);
});
it("previews REST body and command at the assign gate without executing or freezing", async () => {
  const h = await setup({ stage: "Issue更新済", dryRun: true });
  const rows = await h.o.tick();
  expect(rows[0]).toMatchObject({ status: "waiting_gate", gate: "assign", agent: null });
  const body = JSON.parse(await fs.readFile(path.join(h.state, "previews/assignment-1.json"), "utf8"));
  expect(body).toEqual({
    assignees: ["copilot-swe-agent[bot]"],
    agent_assignment: { target_repo: "example-org/example-app", base_branch: "main" },
  });
  expect(mutations(h)).toHaveLength(0);
  expect(await h.o.states.read(1)).toBeNull();
});
it("uses ShellExec dry-run for approved REST assignment and leaves no temporary directory", async () => {
  const h = await setup({ stage: "Issue更新済", dryRun: true });
  h.workflow.gates.assign = "auto";
  const shell = new ShellExec(true, () => {});
  const read = h.a.exec.run;
  h.a.exec.run = vi.fn(async (r) => (r.mutation ? shell.run(r) : read(r)));
  h.a.remote = (step) => new CopilotRemote(h.a.exec, h.a.tracker, step, h.workflow);
  await h.o.tick();
  expect(shell.planned).toHaveLength(1);
  expect(shell.planned[0]?.command).toContain("gh api --method POST");
  expect((await fs.readdir(h.run)).some((n) => n.startsWith("assign-"))).toBe(false);
});
it("gates a mismatching PR base before polling or launching verification", async () => {
  const h = await frozen();
  h.prs.get(1)![0]!.base = "wrong";
  await h.o.tick();
  expect((await h.o.states.read(1))?.gate?.name).toBe("base_changed");
  expect(h.a.remote).not.toHaveBeenCalled();
  expect(h.a.runner.start).not.toHaveBeenCalled();
  await expect(h.o.control(1, "approve")).rejects.toThrow("keep|retarget");
});
it("keep resumes once, preserves frozen base, and a changed snapshot asks again", async () => {
  const h = await frozen();
  h.prs.get(1)![0]!.base = "wrong";
  await h.o.tick();
  await h.o.control(1, "approve", { choice: "keep" });
  await h.o.tick();
  expect((await h.o.states.read(1))?.status).toBe("waiting_remote");
  expect((await h.o.states.read(1))?.base).toBe("main");
  h.prs.get(1)![0]!.base = "another";
  await h.o.tick();
  expect((await h.o.states.read(1))?.gate?.name).toBe("base_changed");
});
it("weekly rollover preserves a pre-existing finish_start gate after keep", async () => {
  const h = await frozen();
  const s = (await h.o.states.read(1))!;
  s.step = "finish";
  s.status = "waiting_gate";
  s.gate = {
    name: "finish_start",
    phase: "before",
    since: new Date().toISOString(),
    summary: "finish",
    artifacts: [],
  };
  await h.o.save(s);
  h.stages.set(1, "検証済");
  vi.mocked(h.a.exec.run).mockResolvedValue("release/new");
  await h.o.tick();
  await h.o.control(1, "approve", { choice: "keep" });
  expect((await h.o.states.read(1))?.gate?.name).toBe("finish_start");
  await h.o.tick();
  expect(h.a.runner.start).not.toHaveBeenCalled();
  expect((await h.o.states.read(1))?.base).toBe("main");
});
it("retarget edits only after approval and updates the frozen base", async () => {
  const h = await frozen();
  vi.mocked(h.a.exec.run).mockImplementation(async (r) => (r.mutation ? "" : "release/new"));
  await h.o.tick();
  expect(mutations(h)).toHaveLength(0);
  await h.o.control(1, "approve", { choice: "retarget" });
  expect(mutations(h)).toEqual([[expect.objectContaining({ command: "gh pr edit 101 --base 'release/new'" })]]);
  expect((await h.o.states.read(1))?.base).toBe("release/new");
  expect((await h.o.states.read(1))?.status).toBe("waiting_remote");
});
it("refuses stale base_changed approval and retarget without a unique PR", async () => {
  const h = await frozen();
  vi.mocked(h.a.exec.run).mockResolvedValue("release/new");
  await h.o.tick();
  vi.mocked(h.a.exec.run).mockResolvedValue("release/newer");
  await expect(h.o.control(1, "approve", { choice: "retarget" })).rejects.toThrow("変更されています");
  h.prs.set(1, []);
  await h.o.tick();
  await expect(h.o.control(1, "approve", { choice: "retarget" })).rejects.toThrow("PR が1件");
  expect(mutations(h)).toHaveLength(0);
});
it("uncertain retarget uses operation recovery and confirmed applied resumes original gate", async () => {
  const h = await frozen();
  vi.mocked(h.a.exec.run).mockImplementation(async (r) => {
    if (r.mutation) throw new Error("lost response");
    return "release/new";
  });
  await h.o.tick();
  await h.o.control(1, "approve", { choice: "retarget" });
  await h.o.tick();
  expect((await h.o.states.read(1))?.gate?.name).toBe("operation_recovery");
  expect(mutations(h)).toHaveLength(1);
  await h.o.control(1, "approve", { choice: "applied" });
  expect((await h.o.states.read(1))?.base).toBe("release/new");
  expect((await h.o.states.read(1))?.status).toBe("waiting_remote");
  expect(mutations(h)).toHaveLength(1);
});
it("verification context uses the frozen base even after keep at rollover", async () => {
  const h = await frozen();
  vi.mocked(h.a.exec.run).mockResolvedValue("release/new");
  await h.o.tick();
  await h.o.control(1, "approve", { choice: "keep" });
  expect((await h.o.context((await h.o.states.read(1))!)).base).toBe("main");
});
it("REST assignment supports configured login and fields without shell interpolation in JSON", async () => {
  const workflow = await config();
  const step = workflow.steps.implement!;
  step.remote!.login = "custom-bot";
  step.remote!.agent_assignment!.custom_instructions = "literal ' \" $(touch /tmp/do-not-run)\ntext";
  const exec = { run: vi.fn(async () => "") };
  const result = await new RestAssignment().prepare(exec, workflow, step, 42, "release/test");
  expect(result.body).toMatchObject({
    assignees: ["custom-bot"],
    agent_assignment: {
      base_branch: "release/test",
      custom_instructions: step.remote!.agent_assignment!.custom_instructions,
    },
  });
  expect(exec.run).not.toHaveBeenCalled();
  step.remote!.agent_assignment!.base_branch = "wrong";
  await expect(new RestAssignment().prepare(exec, workflow, step, 42, "release/test")).rejects.toThrow("一致");
});
it("GraphQL transport resolves node IDs with a read and prepares replaceActorsForAssignable separately", async () => {
  const workflow = await config();
  const step = workflow.steps.implement!;
  step.remote!.transport = "graphql";
  step.remote!.assign =
    "gh api graphql -H 'GraphQL-Features: issues_copilot_assignment_api_support,coding_agent_model_selection' --input {assign_body}";
  const exec = {
    run: vi.fn(async () =>
      JSON.stringify({
        data: {
          repository: {
            issue: { id: "I_1" },
            suggestedActors: { nodes: [{ login: "copilot-swe-agent", id: "B_1" }] },
          },
          target: { id: "R_1" },
        },
      }),
    ),
  };
  const result = await new GraphQLAssignment().prepare(exec, workflow, step, 42, "release/test");
  expect(result.body).toMatchObject({
    query: expect.stringContaining("replaceActorsForAssignable"),
    variables: {
      input: {
        assignableId: "I_1",
        actorIds: ["B_1"],
        agentAssignment: { targetRepositoryId: "R_1", baseRef: "release/test" },
      },
    },
  });
  expect(exec.run.mock.calls).toHaveLength(1);
  expect(exec.run).toHaveBeenCalledWith(expect.objectContaining({ mutation: false }));
});
it("writes the exact REST body before the fake POST, freezes state first and cleans the body afterwards", async () => {
  const h = await setup({ stage: "Issue更新済" });
  h.workflow.gates.assign = "auto";
  let bodyPath = "";
  h.a.exec.run = vi.fn(async (r) => {
    if (!r.mutation) return "release/current";
    expect(r.command).toContain(
      "gh api --method POST /repos/'example-org'/'example-app'/issues/'1'/assignees --input ",
    );
    bodyPath = /--input '([^']+)'/.exec(r.command)![1]!;
    expect(JSON.parse(await fs.readFile(bodyPath, "utf8"))).toEqual({
      assignees: ["copilot-swe-agent[bot]"],
      agent_assignment: {
        target_repo: "example-org/example-app",
        base_branch: "release/current",
      },
    });
    expect((await h.o.states.read(1))?.base).toBe("release/current");
    return "";
  });
  h.a.remote = (step) => new CopilotRemote(h.a.exec, h.a.tracker, step, h.workflow);
  await h.o.tick();
  expect((await h.o.states.read(1))?.status).toBe("waiting_remote");
  await expect(fs.access(bodyPath)).rejects.toThrow();
  expect(mutations(h)).toHaveLength(1);
});
it("base failure also defers a frozen waiting_remote without polling", async () => {
  const h = await frozen();
  vi.mocked(h.a.exec.run).mockRejectedValue(new Error("offline"));
  await h.o.tick();
  expect(h.a.remote).not.toHaveBeenCalled();
  expect((await h.o.states.read(1))?.status).toBe("waiting_remote");
});
it("retarget failure retry returns to the base gate and preserves the suspended gate", async () => {
  const h = await frozen();
  vi.mocked(h.a.exec.run).mockImplementation(async (r) => {
    if (r.mutation) throw new Error("lost");
    return "new";
  });
  await h.o.tick();
  await h.o.control(1, "approve", { choice: "retarget" });
  await h.o.control(1, "approve", { choice: "retry" });
  expect((await h.o.states.read(1))?.gate?.name).toBe("base_changed");
  await h.o.control(1, "approve", { choice: "keep" });
  expect((await h.o.states.read(1))?.status).toBe("waiting_remote");
});
