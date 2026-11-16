import { CopilotRemote } from "../adapters/copilot.js";
import { DirsStageStore } from "../adapters/dirs.js";
import { ShellExec } from "../adapters/exec.js";
import { GitHubTracker } from "../adapters/github.js";
import { HerdrRunner, HerdrWorkspace } from "../adapters/herdr.js";
import { CommandNotifier } from "../adapters/notifier.js";
import { CommandError } from "../core/command-error.js";
import { Events } from "../core/events.js";
import { json } from "../core/files.js";
import { migrateLegacy } from "../core/migration.js";
import { Orchestrator, type StatusRow } from "../core/orchestrator.js";
import { Ownership } from "../core/ownership.js";
import { FlowPaths } from "../core/paths.js";
import { orderStages } from "../core/stage-order.js";
import { WorkflowLoader, issueLink } from "../core/workflow.js";
import type { IssueLocation } from "../display-text.js";
import { type IssueLink, Output } from "../output.js";
import type { Adapters, State, Workflow } from "../types.js";
import { LiveFrame, type LiveScreen } from "./live-frame.js";
import { outputClosed, stderr, stdout } from "./stdio.js";
import { type RunTool, runTool } from "./tools.js";

export type CliServices = {
  paths: FlowPaths;
  view?: Output;
  errorView?: Output;
  open: (dryRun: boolean, fallback?: boolean, persist?: boolean) => Promise<Orchestrator>;
  output: (text: string) => void;
  error: (text: string) => void;
  /** Present only on a terminal: `flow run` keeps one frame in place. */
  live?: LiveScreen;
  outputSignal?: AbortSignal;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Runs a bundled tools/ script; tests replace it. */
  runTool?: RunTool;
};
export function createServices(root: string): CliServices {
  const paths = new FlowPaths(root);
  const view = new Output();
  const errorView = new Output({ stream: process.stderr });
  return {
    paths,
    view,
    errorView,
    runTool,
    async open(dryRun, fallback = true, persist = !dryRun) {
      await migrateLegacy(paths);
      const loaded = await new WorkflowLoader(paths.workflow, root).load(fallback, persist);
      const o = new Orchestrator(loaded.workflow, adapters(loaded.workflow, dryRun, root, view), root, dryRun, (text) =>
        stdout.write(view.prose(text, "muted")),
      );
      if (loaded.warning)
        await o.notify(
          { issue: 0, step: null } as State,
          "設定の読み込み失敗。直前の正常な設定を継続",
          loaded.warning,
          "error",
        );
      return o;
    },
    output: stdout.write,
    error: (text) => stderr.write(errorView.prose(text, "error")),
    // stderr joins the frame only when it shares the terminal; a redirected stderr keeps its lines.
    live: process.stdout.isTTY
      ? new LiveFrame(stdout, process.stdout, process.stderr.isTTY ? [stdout, stderr] : [stdout])
      : undefined,
    outputSignal: outputClosed,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}
export function adapters(workflow: Workflow, dryRun: boolean, root: string, view = new Output()): Adapters {
  const exec = new ShellExec(dryRun, (text) => stdout.write(view.prose(text, "muted")));
  const main = String(workflow.vars.main);
  const owned = new Ownership(root, dryRun);
  const events = new Events(root, dryRun);
  const warn = async (message: string) => {
    stderr.write(new Output({ stream: process.stderr }).prose(`警告: ${message}`, "pending"));
    await events.add(0, null, "warning", message);
  };
  const tracker = new GitHubTracker(exec, workflow.tracker, main);
  return {
    ownership: owned,
    exec,
    tracker,
    stages: new DirsStageStore(exec, workflow.stage_store, workflow.vars, dryRun),
    workspace: new HerdrWorkspace(exec, workflow.workspace, workflow.vars, dryRun, owned, warn),
    runner: new HerdrRunner(exec, workflow.runner, main, dryRun, owned, warn),
    notifier: new CommandNotifier(exec, workflow, stdout.write, view),
    remote: (step) => new CopilotRemote(exec, tracker, step, workflow),
  };
}
export function table(
  rows: StatusRow[],
  output: (text: string) => void,
  view = new Output({ isTTY: false }),
  rejected?: string,
  order?: string[],
  link?: IssueLink,
): void {
  output(view.status(orderStages(rows, order), rejected, link));
}
export async function issueLocations(o: Orchestrator, numbers: number[]): Promise<Map<number, IssueLocation>> {
  const locations = new Map<number, IssueLocation>();
  await Promise.all(
    [...new Set(numbers)]
      .filter((n) => n > 0)
      .map(async (issue) => {
        try {
          const dir = await o.a.stages.dir(issue);
          locations.set(issue, { dir, issue, pattern: o.workflow.stage_store.pattern });
        } catch {
          /* Missing/moved Issue directories must not hide logs. */
        }
      }),
  );
  return locations;
}
async function readStatus(o: Orchestrator, issue?: number): Promise<{ rows: StatusRow[]; details?: State | null }> {
  const issues = await o.a.tracker.listCandidates();
  const states: State[] = [];
  const unscheduled: StatusRow[] = [];
  for (const n of new Set([...(await o.states.numbers()), ...issues.map((i) => i.number), ...(issue ? [issue] : [])])) {
    if (issue && n !== issue) continue;
    try {
      const stage = await o.a.stages.get(n);
      const state = stage ? await o.states.read(n) : null;
      if (state) states.push(state);
      else
        unscheduled.push({
          issue: n,
          title: issues.find((i) => i.number === n)?.title ?? "",
          stage,
          step:
            Object.entries(o.workflow.steps).find(
              ([, step]) => step.when_stage === (stage ?? o.workflow.stage_store.initial),
            )?.[0] ?? null,
          status: "未登録",
          gate: null,
          agent: null,
          slot: null,
          elapsed: 0,
        });
    } catch (e) {
      if (e instanceof CommandError) await o.events.add(n, null, "command_error", String(e), e.details);
      unscheduled.push({
        issue: n,
        title: "",
        stage: null,
        step: null,
        status: "error",
        gate: null,
        agent: null,
        slot: null,
        elapsed: 0,
        error: String(e),
      });
    }
  }
  return {
    rows: orderStages([...(await o.rows(states, issues)), ...unscheduled], o.workflow.stage_store.order),
    details: issue ? (states.find((s) => s.issue === issue) ?? null) : undefined,
  };
}

export async function showStatus(
  o: Orchestrator,
  paths: FlowPaths,
  issue: number | undefined,
  asJson: boolean,
  output: (text: string) => void,
  view = new Output({ isTTY: false }),
): Promise<void> {
  const result = await readStatus(o, issue);
  // The Issue directory holds its artifacts; the operator reads them from here.
  const locations = issue ? await issueLocations(o, [issue]) : undefined;
  if (asJson)
    output(JSON.stringify(issue ? { ...result, dir: locations?.get(issue)?.dir ?? null } : result.rows, null, 2));
  else {
    table(
      result.rows,
      output,
      view,
      o.workflow.stage_store.rejected,
      o.workflow.stage_store.order,
      issueLink(o.workflow),
    );
    if (issue && locations) {
      output(view.heading("詳細"));
      const dir = locations.get(issue)?.dir;
      if (dir) output(view.prose(`ディレクトリ: ${dir}`));
      output(
        view.details(
          result.details,
          o.workflow.timezone,
          result.rows.some((r) => r.stage === o.workflow.stage_store.rejected),
          locations.get(issue),
        ),
      );
      if (result.details?.gate?.phase === "question" && result.details.agent) {
        try {
          await o.owned.assertAgent(result.details.agent);
          output(view.heading("agent のペイン末尾"));
          output(view.prose(await o.a.runner.tail(result.details.agent, 80)));
        } catch (error) {
          output(view.prose(`ペインを取得できません: ${String(error)}`));
        }
      }
      output(view.heading("最近のログ"));
      output(view.logs((await o.events.read(issue)).slice(-15), o.workflow.timezone, locations));
    }
  }
  const plan = await json<StatusRow[]>(paths.plan);
  if (!asJson && plan) {
    output(view.prose("\n前回の dry-run の予定（永続状態ではありません）", "muted"));
    table(
      plan.filter((r) => !issue || r.issue === issue),
      output,
      view,
      o.workflow.stage_store.rejected,
      o.workflow.stage_store.order,
      issueLink(o.workflow),
    );
  }
}
