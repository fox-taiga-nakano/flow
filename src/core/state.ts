import path from "node:path";

import type { AgentResult, StageStore, State, Workflow } from "../types.js";
import { isDbResetRequest } from "./db-reset.js";
import { artifact, atomic, exists, json } from "./files.js";
import { FlowPaths } from "./paths.js";

export function initialState(issue: number, now = new Date().toISOString()): State {
  return {
    version: 1,
    issue,
    step: null,
    status: "idle",
    attempt: 0,
    agent: null,
    workspace: null,
    workspaces: [],
    locks: [],
    gate: null,
    nextRetryAt: null,
    startedAt: null,
    updatedAt: now,
    statusChangedAt: now,
    lastActivityAt: now,
    history: [],
    approvals: [],
    completed: [],
    effects: [],
  };
}
export function checkState(s: State, issue: number, steps?: Workflow["steps"], now = new Date().toISOString()): State {
  // Version 1 permits the minimal SPEC schema; these fields are additive execution metadata.
  if (s && typeof s === "object") {
    if (!Object.hasOwn(s, "workspaces")) s.workspaces = s.workspace ? [s.workspace] : [];
    if (!Object.hasOwn(s, "effects")) s.effects = [];
    if (!Object.hasOwn(s, "approvals")) s.approvals = [];
    if (!Object.hasOwn(s, "completed")) s.completed = [];
    if (s.gate && !s.gate.phase) {
      const step = steps?.[s.step!];
      const phase =
        s.gate.name === "base_changed"
          ? "base"
          : s.gate.name === "adopt_workspace"
            ? "adopt"
            : s.gate.name === "agent_question"
              ? "question"
              : s.gate.name === "db_reset"
                ? "db"
                : step?.gate_before === s.gate.name
                  ? "before"
                  : step?.gate_after === s.gate.name
                    ? "after"
                    : step?.on_ng?.gate === s.gate.name
                      ? "ng"
                      : null;
      if (!phase) throw new Error(`gate の処理箇所を判定できません: #${issue}`);
      s.gate.phase = phase;
    }
  }
  if (
    !s ||
    s.version !== 1 ||
    s.issue !== issue ||
    !["idle", "running", "waiting_gate", "waiting_remote", "retry_wait", "failed", "stopped", "done"].includes(
      s.status,
    ) ||
    !Number.isInteger(s.attempt) ||
    s.attempt < 0 ||
    !Array.isArray(s.history) ||
    !Array.isArray(s.locks) ||
    !Array.isArray(s.workspaces) ||
    !Array.isArray(s.effects) ||
    !Array.isArray(s.approvals) ||
    !Array.isArray(s.completed) ||
    typeof s.updatedAt !== "string" ||
    typeof s.lastActivityAt !== "string" ||
    !Number.isFinite(Date.parse(s.updatedAt)) ||
    (s.statusChangedAt !== undefined && !Number.isFinite(Date.parse(s.statusChangedAt))) ||
    (s.initialPrompt !== undefined && typeof s.initialPrompt !== "string") ||
    (s.issueTabBusy !== undefined && typeof s.issueTabBusy !== "boolean") ||
    (s.dbReset !== undefined &&
      (!isDbResetRequest(s.dbReset) ||
        typeof s.dbReset.key !== "string" ||
        !s.dbReset.workspace ||
        typeof s.dbReset.workspace.path !== "string" ||
        !path.isAbsolute(s.dbReset.workspace.path))) ||
    (s.worker != null && (typeof s.worker !== "object" || typeof s.worker.name !== "string")) ||
    !Number.isFinite(Date.parse(s.lastActivityAt)) ||
    !s.locks.every((x) => typeof x === "string") ||
    !s.effects.every((x) => typeof x === "string") ||
    !s.approvals.every((x) => typeof x === "string") ||
    !s.completed.every((x) => typeof x === "string") ||
    (s.base !== undefined && (typeof s.base !== "string" || !s.base.trim())) ||
    (s.rejectedFromStage !== undefined && (typeof s.rejectedFromStage !== "string" || !s.rejectedFromStage.trim())) ||
    (s.baseAccepted !== undefined && typeof s.baseAccepted !== "string") ||
    (s.baseChange !== undefined &&
      (typeof s.baseChange.signature !== "string" ||
        typeof s.baseChange.current !== "string" ||
        !s.baseChange.current.trim())) ||
    (s.step !== null && typeof s.step !== "string") ||
    (s.status === "waiting_gate" && !s.gate)
  )
    throw new Error(`state.json が不正です: #${issue}`);
  // Legacy states did not record status changes. Prefer the actual gate/history time;
  // when no reliable time exists, use the read time until the next status change.
  s.statusChangedAt ??=
    [s.gate?.since, s.history.at(-1)?.at, s.startedAt, s.remoteSince].find(
      (at) => typeof at === "string" && Number.isFinite(Date.parse(at)),
    ) ?? now;
  return s;
}
export class States {
  constructor(
    readonly rootDir: string,
    readonly stages: StageStore,
    readonly dryRun = false,
    readonly steps?: Workflow["steps"],
    readonly now = () => new Date(),
  ) {}
  private snapshots = new Map<number, string>();
  private index?: Set<number>;
  private indexDirty = false;
  private batching = false;
  async beginTick(): Promise<void> {
    this.snapshots.clear();
    this.index = new Set(await this.numbers());
    this.indexDirty = false;
    this.batching = true;
  }
  async endTick(): Promise<void> {
    try {
      if (!this.dryRun && this.indexDirty) await atomic(new FlowPaths(this.rootDir).issues, [...this.index!]);
    } finally {
      this.batching = false;
      this.index = undefined;
    }
  }
  async numbers(): Promise<number[]> {
    return this.index ? [...this.index] : ((await json<number[]>(new FlowPaths(this.rootDir).issues)) ?? []);
  }
  async register(n: number): Promise<void> {
    if (this.dryRun) return;
    if (this.batching) {
      if (!this.index!.has(n)) {
        this.index!.add(n);
        this.indexDirty = true;
      }
    } else {
      const numbers = await this.numbers();
      if (!numbers.includes(n)) await atomic(new FlowPaths(this.rootDir).issues, [...numbers, n]);
    }
  }
  async read(n: number): Promise<State | null> {
    const file = FlowPaths.issueState(await this.stages.dir(n));
    const s = await json<State>(file);
    if (s === null && (await exists(file))) throw new Error(`state.json が不正です: #${n}`);
    if (s === null) {
      this.snapshots.delete(n);
      return null;
    }
    const checked = checkState(s, n, this.steps, this.now().toISOString());
    this.snapshots.set(n, JSON.stringify(checked));
    return checked;
  }
  async write(s: State): Promise<void> {
    const before = this.snapshots.get(s.issue);
    await this.register(s.issue);
    if (before === JSON.stringify(s)) return;
    const previous = before ? (JSON.parse(before) as State) : undefined;
    const at = this.now().toISOString();
    if (!previous || previous.status !== s.status || previous.step !== s.step) s.statusChangedAt = at;
    else s.statusChangedAt ??= previous.statusChangedAt ?? at;
    s.updatedAt = at;
    if (!this.dryRun) await atomic(FlowPaths.issueState(await this.stages.dir(s.issue)), s);
    this.snapshots.set(s.issue, JSON.stringify(s));
  }
  async result(s: State): Promise<AgentResult | null> {
    const file = FlowPaths.result(await this.stages.dir(s.issue), s.step, s.attempt);
    const r = await json<AgentResult>(file);
    if (r === null && (await exists(file))) throw new Error("result.json の形式が不正です");
    if (
      r !== null &&
      (!r ||
        !["ok", "ng", "blocked", "failed"].includes(r.result) ||
        typeof r.summary !== "string" ||
        !r.summary.trim() ||
        r.summary.trim().split("\n").length > 3 ||
        !Array.isArray(r.artifacts) ||
        !r.artifacts.every((x) => typeof x === "string") ||
        (r.result === "blocked" && (typeof r.needs !== "string" || !r.needs.trim())) ||
        (r.db_reset !== undefined && (r.result !== "blocked" || !isDbResetRequest(r.db_reset))))
    )
      throw new Error("result.json の形式が不正です");
    if (r) for (const f of r.artifacts) artifact(await this.stages.dir(s.issue), f);
    return r;
  }
}
