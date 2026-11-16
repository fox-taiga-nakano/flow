import { promises as fs } from "node:fs";
import path from "node:path";
import { vi } from "vite-plus/test";

import { RestAssignment } from "../src/adapters/assignment.js";
import { atomic } from "../src/core/files.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { parseWorkflow } from "../src/core/workflow.js";
import type { Adapters, RunnerAgent, TrackerIssue, TrackerPR, Workflow, WorkspaceInfo } from "../src/types.js";

type TestFunctions<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => R : T[K] };
type TestAdapters = {
  [K in keyof Adapters]: Adapters[K] extends (...args: infer A) => infer R
    ? (...args: A) => R
    : TestFunctions<Adapters[K]>;
};

export const issue = (n = 1): TrackerIssue => ({
  number: n,
  title: `Issue ${n}`,
  state: "open",
  assignees: ["me"],
  labels: [],
  createdAt: `2026-01-${String(n).padStart(2, "0")}T00:00:00Z`,
  url: `https://example.test/issues/${n}`,
});
export const pr = (n = 101): TrackerPR => ({
  number: n,
  branch: `branch-${n}`,
  base: "main",
  state: "open",
  isDraft: true,
  author: "app/copilot-swe-agent",
  url: `https://example.test/pull/${n}`,
});
/** Every agent launch through the runner. */
export const starts = (a: TestAdapters) => vi.mocked(a.runner.start).mock.calls;
export async function temp(): Promise<string> {
  const base = path.resolve(".flow/test/.tmp");
  const actual = path.basename(process.cwd()) === ".flow" ? path.resolve("test/.tmp") : base;
  await fs.mkdir(actual, { recursive: true });
  return fs.mkdtemp(path.join(actual, "case-"));
}
export async function config(): Promise<Workflow> {
  return parseWorkflow(await fs.readFile(path.resolve(import.meta.dirname, "../test/fixtures/WORKFLOW.md"), "utf8"));
}
export async function harness(options: { dryRun?: boolean; stage?: string; count?: number } = {}) {
  const dir = await temp();
  const workflow = await config();
  workflow.vars.main = dir;
  workflow.gates.start = "auto";
  workflow.gates.verify_start = "auto";
  const candidates = Array.from({ length: options.count ?? 1 }, (_, i) => issue(i + 1));
  const stages = new Map(candidates.map((i) => [i.number, options.stage ?? "未着手"]));
  const prs = new Map<number, TrackerPR[]>();
  const workspaces: WorkspaceInfo[] = [];
  const files = new Map<number, string>();
  for (const i of candidates) {
    const d = path.join(dir, `issues/${i.number}`);
    await fs.mkdir(d, { recursive: true });
    files.set(i.number, d);
  }
  const a: TestAdapters = {
    tracker: {
      listCandidates: vi.fn(async () => candidates),
      getIssue: vi.fn(async (n) => candidates.find((i) => i.number === n) ?? null),
      findPullRequests: vi.fn(async (n) => prs.get(n) ?? []),
    },
    stages: {
      get: vi.fn(async (n) => stages.get(n) ?? null),
      set: vi.fn(async (n, s) => {
        stages.set(n, s);
      }),
      ensure: vi.fn(async (n) => files.get(n)!),
      dir: vi.fn(async (n) => files.get(n)!),
    },
    workspace: {
      list: vi.fn(async () => workspaces),
      ensure: vi.fn(async (spec) => {
        const found = workspaces.find((w) => w.branch === spec.branch);
        if (found) return found;
        const w = {
          key: spec.key,
          branch: spec.branch,
          path: path.join(dir, spec.key),
          workspaceId: `w${workspaces.length + 1}`,
          slot: null,
        };
        workspaces.push(w);
        return w;
      }),
      sync: vi.fn(async () => {}),
      remove: vi.fn(async (ws) => {
        const i = workspaces.findIndex((w) => w.path === ws.path);
        if (i >= 0) workspaces.splice(i, 1);
      }),
    },
    runner: {
      list: vi.fn(async () => [] as RunnerAgent[]),
      focusTab: vi.fn(async () => {}),
      start: vi.fn(async (spec) => ({ runner: "herdr", name: spec.name, paneId: "w1:p1" })),
      ready: vi.fn(async () => "ready" as const),
      closeIssueTab: vi.fn(async () => true),
      close: vi.fn(async (handle) => {
        await a.runner.stop(handle);
      }),
      status: vi.fn(async () => "working" as const),
      prompt: vi.fn(async () => {}),
      tail: vi.fn(async () => "work"),
      stop: vi.fn(async () => {}),
    },
    notifier: { notify: vi.fn(async () => {}) },
    remote: vi.fn(() => ({
      prepare: vi.fn(async (issue, base) =>
        new RestAssignment().prepare(a.exec, workflow, workflow.steps.implement!, issue, base),
      ),
      request: vi.fn(async () => {
        await a.exec.run({ command: "remote assign", mutation: true });
      }),
      poll: vi.fn(async () => "working" as const),
    })),
    exec: { run: vi.fn(async (r) => (r.mutation ? "" : "main")) },
  };
  let time = new Date("2026-10-21T01:00:00Z");
  const run = path.join(dir, "run");
  const make = () =>
    new Orchestrator(
      workflow,
      a,
      dir,
      options.dryRun,
      () => {},
      () => time,
    );
  const o = make();
  return {
    dir,
    workflow,
    a,
    o,
    make,
    run,
    state: path.join(dir, "state"),
    candidates,
    stages,
    prs,
    files,
    workspaces,
    advance: (ms: number) => {
      time = new Date(time.getTime() + ms);
    },
    result: async (n: number, result = "ok", summary = "完了") => {
      const s = (await o.states.read(n))!;
      await atomic(path.join(files.get(n)!, `flow/result-${s.step}-${s.attempt}.json`), {
        result,
        summary,
        needs: result === "blocked" ? "回答してください" : undefined,
        artifacts: [],
      });
    },
    file: async (n: number, name: string) => {
      const f = path.join(files.get(n)!, name);
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, "evidence");
    },
  };
}
