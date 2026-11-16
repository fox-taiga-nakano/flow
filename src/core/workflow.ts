import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

import type { Step, Workflow } from "../types.js";
import { atomic, json } from "./files.js";
import { FlowPaths } from "./paths.js";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
function need(v: unknown, message: string): asserts v {
  if (!v) throw new Error(`WORKFLOW: ${message}`);
}
const positive = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;
export function issueLink(workflow: Pick<Workflow, "vars">): (issue: number) => string | undefined {
  const { owner, repo } = workflow.vars ?? {};
  return (issue) => (owner && repo ? `https://github.com/${owner}/${repo}/issues/${issue}` : undefined);
}
export function parseWorkflow(source: string): Workflow {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
  need(match, "YAML front matter がありません");
  const raw: unknown = parse(match[1]!);
  need(object(raw), "設定はオブジェクトです");
  const prompts: Record<string, string> = {};
  const sections = match[2]!.split(/^## prompt:\s*([\w-]+)\s*\r?$/m);
  for (let i = 1; i < sections.length; i += 2) {
    need(!prompts[sections[i]!], `プロンプト重複: ${sections[i]}`);
    prompts[sections[i]!] = sections[i + 1]!.trim();
  }
  need(raw.version === 1, "version は 1");
  need(raw.timezone === undefined || typeof raw.timezone === "string", "timezone は IANA タイムゾーン名です");
  if (raw.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: raw.timezone as string });
    } catch {
      throw new Error("WORKFLOW: timezone は有効な IANA タイムゾーン名です");
    }
  }
  need(object(raw.tracker) && raw.tracker.kind === "github" && object(raw.tracker.query), "tracker が不正");
  need(
    Object.values(raw.tracker.query).every((x) => typeof x === "string"),
    "tracker.query は文字列のマップ",
  );
  need(strings(raw.tracker.exclude_labels), "exclude_labels は配列");
  need(raw.tracker.pr_limit === undefined || positive(raw.tracker.pr_limit), "tracker.pr_limit は正の整数です");
  need(raw.tracker.hold_labels === undefined || strings(raw.tracker.hold_labels), "hold_labels は配列");
  need(
    object(raw.stage_store) &&
      raw.stage_store.kind === "dirs" &&
      typeof raw.stage_store.initial === "string" &&
      object(raw.stage_store.commands),
    "stage_store が不正",
  );
  need(
    typeof raw.stage_store.rejected === "string" &&
      raw.stage_store.rejected.trim() &&
      raw.stage_store.rejected !== raw.stage_store.initial,
    "stage_store.rejected は initial と異なる空でない段階名です",
  );
  need(
    (raw.tracker.hold_labels === undefined) === (raw.stage_store.held === undefined),
    "tracker.hold_labels と stage_store.held はセットで指定してください",
  );
  if (raw.stage_store.held !== undefined)
    need(
      typeof raw.stage_store.held === "string" &&
        raw.stage_store.held.trim() &&
        ![raw.stage_store.initial, raw.stage_store.rejected].includes(raw.stage_store.held),
      "stage_store.held は initial・rejected と異なる空でない段階名です",
    );
  if (raw.stage_store.order !== undefined) {
    need(
      strings(raw.stage_store.order) && raw.stage_store.order.length > 0,
      "stage_store.order は段階名の空でない配列です",
    );
    need(
      raw.stage_store.order.every((name) => name.trim() === name && !!name && !/[\\/\r\n\t]/.test(name)),
      "stage_store.order の段階名は空白・改行・パスを含めず指定してください",
    );
    need(
      new Set(raw.stage_store.order).size === raw.stage_store.order.length,
      "stage_store.order の段階名が重複しています",
    );
  }
  for (const k of ["dir", "ensure", "set"])
    need(typeof raw.stage_store.commands[k] === "string", `stage_store.commands.${k}`);
  need(object(raw.workspace) && raw.workspace.kind === "herdr" && object(raw.workspace.commands), "workspace が不正");
  for (const k of ["list", "create_for_branch", "create_from_base", "sync", "remove"])
    need(typeof raw.workspace.commands[k] === "string", `workspace.commands.${k}`);
  need(object(raw.runner) && raw.runner.kind === "herdr", "runner が不正");
  need(
    raw.runner.commands === undefined || (object(raw.runner.commands) && !Object.keys(raw.runner.commands).length),
    "runner.commands（start / start_main）は廃止しました。agent は flow-<Issue番号> タブで起動します",
  );
  delete raw.runner.commands;
  need(
    raw.runner.close_on_complete === undefined || typeof raw.runner.close_on_complete === "boolean",
    "runner.close_on_complete は真偽値です",
  );
  raw.runner.close_on_complete ??= true;
  for (const [group, commands] of Object.entries({
    stage_store: raw.stage_store.commands,
    workspace: raw.workspace.commands,
  }))
    need(
      Object.values(commands).every((v) => typeof v === "string" && v.trim().length > 0),
      `${group}.commands は空でない文字列のマップです`,
    );
  need(
    object(raw.notifier) &&
      raw.notifier.kind === "command" &&
      (raw.notifier.command == null || typeof raw.notifier.command === "string"),
    "notifier が不正",
  );
  need(
    object(raw.concurrency) &&
      positive(raw.concurrency.global) &&
      object(raw.concurrency.per_step) &&
      Object.values(raw.concurrency.per_step).every(positive),
    "concurrency は正の整数",
  );
  need(
    object(raw.retry) &&
      positive(raw.retry.max_attempts) &&
      Array.isArray(raw.retry.backoff_ms) &&
      raw.retry.backoff_ms.length &&
      raw.retry.backoff_ms.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0),
    "retry が不正",
  );
  need(positive(raw.stall_ms), "stall_ms は正の整数");
  need(
    object(raw.locks) &&
      Array.isArray(raw.locks.slots) &&
      raw.locks.slots.every(positive) &&
      new Set(raw.locks.slots).size === raw.locks.slots.length &&
      object(raw.locks.resources),
    "locks が不正",
  );
  for (const [k, v] of Object.entries(raw.locks.resources))
    need(/^[\w-]+$/.test(k) && object(v) && v.kind === "rw", `資源が不正: ${k}`);
  need(object(raw.gates) && Object.values(raw.gates).every((x) => x === "auto" || x === "manual"), "gates が不正");
  if (raw.database !== undefined)
    need(
      object(raw.database) &&
        typeof raw.database.stop === "string" &&
        !!raw.database.stop.trim() &&
        object(raw.database.reset) &&
        [raw.database.reset.snapshot, raw.database.reset.seed].every((v) => typeof v === "string" && !!v.trim()),
      "database は stop と reset.snapshot / reset.seed のコマンドを指定してください",
    );
  need(
    object(raw.vars) &&
      Object.values(raw.vars).every((x) => typeof x === "string" || typeof x === "number") &&
      typeof raw.vars.main === "string" &&
      path.isAbsolute(raw.vars.main),
    "vars.main は絶対パス",
  );
  need(object(raw.base) && typeof raw.base.resolve === "string" && raw.base.resolve.trim(), "base.resolve が必要です");
  need(raw.gates.base_changed === "manual", "base_changed は選択肢が必要なため manual にしてください");
  need(object(raw.steps) && Object.keys(raw.steps).length, "steps がありません");
  for (const [name, value] of Object.entries(raw.steps)) {
    need(/^[\w-]+$/.test(name) && object(value), `step が不正: ${name}`);
    const step = value as Step;
    need(step.db_reset === undefined || typeof step.db_reset === "boolean", `${name}: db_reset は真偽値`);
    if (step.db_reset)
      need(
        raw.database !== undefined &&
          !!step.agent &&
          !!step.workspace &&
          step.workspace !== "none" &&
          step.locks?.includes("db:shared") &&
          "db_reset" in raw.gates,
        `${name}: db_reset には database・worktree の agent・db:shared ロック・db_reset gate が必要です`,
      );
    need(typeof step.when_stage === "string" || step.when_pr_merged === true, `${name}: 起動条件が必要`);
    need(
      [step.agent, step.remote, step.action].filter(Boolean).length === 1,
      `${name}: agent/remote/action のいずれか1つ`,
    );
    need(step.when_stage !== raw.stage_store.rejected, `${name}: stage_store.rejected を when_stage に指定できません`);
    need(
      raw.stage_store.held === undefined || step.when_stage !== raw.stage_store.held,
      `${name}: stage_store.held を when_stage に指定できません`,
    );
    if (step.agent)
      need(
        ["claude", "codex"].includes(step.agent.kind) &&
          typeof step.agent.name === "string" &&
          step.agent.name.startsWith("flow-") &&
          !!prompts[name],
        `${name}: agent または prompt が不正`,
      );
    if (step.workspace && step.workspace !== "none") {
      need(
        object(step.workspace) &&
          (step.workspace.pr === true ||
            (typeof step.workspace.branch === "string" && typeof step.workspace.from_base === "string")),
        `${name}: workspace が不正`,
      );
    }
    for (const gate of [step.gate_before, step.gate_after, step.on_ng?.gate])
      if (gate) need(gate in raw.gates, `gate 未定義: ${gate}`);
    need(step.skippable === undefined || typeof step.skippable === "boolean", `${name}: skippable は真偽値`);
    if (step.skippable) need(!!step.gate_before, `${name}: skippable には gate_before が必要`);
    if (step.remote)
      need(step.remote.kind === "copilot" && typeof step.remote.assign === "string", `${name}: remote が不正`);
    if (step.remote) {
      need(
        step.remote.transport === undefined || ["rest", "graphql"].includes(step.remote.transport),
        `${name}: remote.transport が不正`,
      );
      need(
        step.remote.login === undefined || (typeof step.remote.login === "string" && !!step.remote.login.trim()),
        `${name}: remote.login が不正`,
      );
      need(
        step.remote.agent_assignment === undefined ||
          (object(step.remote.agent_assignment) &&
            Object.values(step.remote.agent_assignment).every((v) => typeof v === "string")),
        `${name}: agent_assignment は文字列のマップ`,
      );
      need(step.remote.assign.includes("{assign_body}"), `${name}: assign に {assign_body} が必要`);
    }
    if (step.remote?.done_when)
      need(
        ["timeline", "review_requested", "not_draft"].includes(step.remote.done_when),
        `${name}: remote.done_when が不正`,
      );
    if (step.remote?.authors) need(strings(step.remote.authors), `${name}: remote.authors が不正`);
    if (step.action)
      need(
        object(step.action) &&
          (step.action.remove_workspaces === true || typeof step.action.command === "string") &&
          (step.action.remove_workspaces === undefined || typeof step.action.remove_workspaces === "boolean") &&
          (step.action.command === undefined || typeof step.action.command === "string"),
        `${name}: action が不正`,
      );
    if (step.done_when)
      need(
        object(step.done_when) &&
          (!step.done_when.files || strings(step.done_when.files)) &&
          (!step.done_when.stage_in || strings(step.done_when.stage_in)),
        `${name}: done_when が不正`,
      );
    for (const file of step.done_when?.files ?? [])
      need(
        file.length > 0 && !path.isAbsolute(file) && !file.split(/[\\/]/).includes(".."),
        `${name}: done_when.files は Issue 内の相対パスです`,
      );
    for (const transition of [step.on_ok, step.on_ng, step.on_done])
      if (transition)
        need(
          object(transition) &&
            (!transition.set_stage || typeof transition.set_stage === "string") &&
            (transition.stop === undefined || typeof transition.stop === "boolean") &&
            (transition.remove_workspaces === undefined ||
              (strings(transition.remove_workspaces) &&
                transition.remove_workspaces.every((branch: string) => branch.length > 0))),
          `${name}: 遷移が不正`,
        );
    if (step.locks) {
      need(strings(step.locks), `${name}: locks が不正`);
      for (const lock of step.locks)
        need(
          lock === "slot" || (/^([\w-]+):(shared|exclusive)$/.test(lock) && lock.split(":")[0]! in raw.locks.resources),
          `未知の lock: ${lock}`,
        );
    }
    if (step.on_approve)
      need(
        object(step.on_approve) &&
          [step.on_approve.command, step.on_approve.prompt].filter((x) => typeof x === "string").length === 1,
        `${name}: on_approve は command/prompt のいずれか`,
      );
  }
  if (raw.remote)
    need(
      object(raw.remote) &&
        strings(raw.remote.authors) &&
        ["timeline", "review_requested", "not_draft"].includes(String(raw.remote.done_when)),
      "remote 設定が不正",
    );
  if (object(raw.remote) && raw.remote.ng_action !== undefined)
    need(
      object(raw.remote.ng_action) &&
        typeof raw.remote.ng_action.command === "string" &&
        typeof raw.remote.ng_action.set_stage === "string" &&
        (raw.remote.ng_action.choice === undefined ||
          (typeof raw.remote.ng_action.choice === "string" &&
            ["copilot", "self", "stop"].includes(raw.remote.ng_action.choice))),
      "remote.ng_action が不正",
    );
  if (raw.gates.ng_action === "auto")
    need(
      object(raw.remote) &&
        object(raw.remote.ng_action) &&
        ["copilot", "self", "stop"].includes(String(raw.remote.ng_action.choice)),
      "ng_action:auto は remote.ng_action.choice が必要です",
    );
  need(
    Object.values(raw.steps).every(
      (s) =>
        !(s as Step).workspace ||
        (s as Step).workspace === "none" ||
        "adopt_workspace" in (raw.gates as Record<string, unknown>),
    ),
    "workspace を使う場合は adopt_workspace gate を定義してください",
  );
  const stages = Object.values(raw.steps)
    .map((s) => (s as Step).when_stage)
    .filter(Boolean);
  need(new Set(stages).size === stages.length, "when_stage が重複しています");
  need(Object.values(raw.steps).filter((s) => (s as Step).when_pr_merged).length <= 1, "when_pr_merged は1つまで");
  need(
    Object.keys(raw.tracker.query).every((k) =>
      ["assignee", "state", "label", "search", "milestone", "author"].includes(k),
    ),
    "tracker.query に未対応の条件があります",
  );
  const workflow = { ...raw, prompts } as unknown as Workflow;
  if (workflow.stage_store.pattern) new RegExp(workflow.stage_store.pattern);
  // Validate placeholders before any command is run. Shell braces such as ${VAR} and JSON objects are unaffected.
  const known: Record<string, string[] | null> = {
    issue: ["number", "title", "state", "createdAt", "url"],
    pr: ["number", "branch", "base", "url", "author", "state", "isDraft"],
    ws: ["key", "path", "workspaceId", "branch", "slot"],
    vars: Object.keys(workflow.vars),
    attempt: [],
    last_failure: [],
    assign_body: [],
    flow_dir: [],
    issue_dir: [],
    branch: [],
    base: [],
    main: [],
    name: [],
    stage: [],
    path: [],
    pane: [],
    workspace: [],
    kind: [],
    slot: [],
    title: [],
    body: [],
    level: [],
    sound: [],
    key: [],
    ...Object.fromEntries(Object.keys(workflow.vars).map((x) => [x, []])),
  };
  const walk = (v: unknown): void => {
    if (typeof v === "string")
      for (const m of v.matchAll(/(?<!\$)\{([A-Za-z_][\w]*(?:\.[\w]+)*)\}/g)) {
        const [root, ...rest] = m[1]!.split(".");
        need(
          Object.hasOwn(known, root!) && (rest.length === 0 || (rest.length === 1 && known[root!]!.includes(rest[0]!))),
          `未定義の変数: ${m[1]}`,
        );
      }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (object(v)) Object.values(v).forEach(walk);
  };
  // vars are literal data, not templates.
  const { vars: _vars, ...templates } = workflow;
  walk(templates);
  return workflow;
}
export class WorkflowLoader {
  constructor(
    readonly file: string,
    readonly rootDir: string,
  ) {}
  async load(fallback = true, persist = true): Promise<{ workflow: Workflow; warning?: string }> {
    try {
      const source = await fs.readFile(this.file, "utf8");
      const workflow = parseWorkflow(source);
      if (persist) await atomic(new FlowPaths(this.rootDir).workflowGood, source);
      return { workflow };
    } catch (e) {
      if (!fallback) throw e;
      const last = await json<string>(new FlowPaths(this.rootDir).workflowGood);
      if (!last) throw e;
      return { workflow: parseWorkflow(last), warning: String(e) };
    }
  }
}
