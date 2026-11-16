import { promises as fs } from "node:fs";
import path from "node:path";

import type { DbResetRequest, State } from "../types.js";
import { exists } from "./files.js";
import { approved, gateKey } from "./gates.js";
import type { Orchestrator } from "./orchestrator.js";
import { sameWorkspace } from "./ownership.js";
import { FlowPaths } from "./paths.js";
import { render } from "./template.js";

export function isDbResetRequest(value: unknown): value is DbResetRequest {
  if (!value || typeof value !== "object") return false;
  const r = value as DbResetRequest;
  return (
    typeof r.id === "string" &&
    /^[a-zA-Z0-9_-]{1,64}$/.test(r.id) &&
    ["snapshot", "seed"].includes(r.mode) &&
    typeof r.reason === "string" &&
    !!r.reason.trim()
  );
}

/** Called by tick, never by the agent's shell. Waiting for another reader never blocks tick. */
export async function resetDatabase(o: Orchestrator, s: State): Promise<void> {
  const request = s.dbReset!;
  const config = o.workflow.database;
  if (!config || !o.workflow.steps[s.step!]?.db_reset) throw new Error("この step の DB リセットは設定されていません");
  const { workspace: ws, key } = request;
  if (s.effects.includes(`${key}:resume`)) {
    delete s.dbReset;
    s.gate = null;
    s.status = "running";
    await o.save(s);
    return;
  }
  if (
    !s.workspace ||
    !sameWorkspace(ws, s.workspace) ||
    path.resolve(ws.path) === path.resolve(String(o.workflow.vars.main))
  )
    throw new Error("DB リセット対象の worktree が変更されています");
  const owned = await o.owned.workspace(ws);
  if (!owned || owned.issue !== s.issue || !(await o.a.workspace.list()).some((w) => sameWorkspace(w, ws)))
    throw new Error("DB リセット対象の worktree の所有・存在を確認できません");
  if (await o.owned.foreignBusy(ws, await o.a.runner.list())) return;
  // A result file does not prove that the agent has stopped using the DB.
  if (!s.agent) throw new Error("DB リセット対象の agent がありません");
  const status = await o.agentStatus(s.agent);
  if (status === "gone") throw new Error("DB リセットを依頼した agent が見つかりません");
  if (status !== "idle" && status !== "done") return;
  if (o.dryRun) {
    o.output(`[dry-run DB RESET SKIPPED] #${s.issue} cwd=${ws.path} mode=${request.mode}: ${request.reason}`);
    return;
  }
  const syncLocks = async () => {
    s.locks = (await o.locks.list()).holders.filter((h) => h.issue === s.issue).map((h) => h.resource);
    await o.save(s);
  };
  if (!s.effects.includes(`${key}:reset`)) {
    if (!approved(o.workflow, s, "db_reset", "db")) {
      await o.gate(s, "db_reset", "db", `DB リセット (${request.mode}) / WT=${ws.path}: ${request.reason}`);
      return;
    }
    await o.locks.queue("db:exclusive", s.issue);
    const held = await o.locks.acquire(["db:exclusive"], s.issue);
    await syncLocks();
    if (!held) return;
    s.approvals = s.approvals.filter((k) => k !== gateKey(s, "db_reset", "db"));
    s.status = "running";
    s.gate = null;
    await o.save(s);
    const context = await o.context(s);
    for (const [phase, source] of [
      ["stop", config.stop],
      ["reset", config.reset[request.mode]],
    ] as const) {
      const command = render(source, { ...context, issue: s.issue }, true);
      if (
        !(await o.command(s, source, `${key}:${phase}`, context, async () => {
          await o.a.exec.run({ command, cwd: ws.path, mutation: true });
        }))
      )
        return;
    }
    await o.events.add(
      s.issue,
      s.step,
      "db_reset",
      `id=${request.id} mode=${request.mode} WT=${ws.path}: ${request.reason}`,
    );
  }
  // Preserve read protection before releasing the writer, including after a runner restart.
  if (!(await o.locks.downgrade("db:exclusive", s.issue)) && !(await o.locks.acquire(["db:shared"], s.issue))) return;
  await syncLocks();
  const dir = await o.a.stages.dir(s.issue);
  const file = FlowPaths.result(dir, s.step, s.attempt);
  const message = `flow 本体が DB リセット (${request.mode}, id=${request.id}) を正常に完了しました。dev を起動し直し、ブラウザに再ログインして同じ試行の手順を再開してください。完了時は ${file} に最終結果を書いてください。リセットは再実行しないでください。`;
  if (
    !(await o.command(s, message, `${key}:resume`, {}, async () => {
      if (await exists(file))
        await fs.rename(file, FlowPaths.result(dir, s.step, s.attempt, `.db-reset-${request.id}`));
      await o.promptOwned(s.agent!, message);
    }))
  )
    return;
  delete s.dbReset;
  s.gate = null;
  s.status = "running";
  s.resultReminder = false;
  s.lastActivityAt = o.now().toISOString();
  await o.save(s);
}
