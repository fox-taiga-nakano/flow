import { Command, CommanderError } from "commander";
import stringWidth from "string-width";

import { errorMessage } from "./errors.js";
import { Output } from "./output.js";
import type { CliServices } from "./runtime.js";

export const summaries: Record<string, string> = {
  tick: "tick を1回実行",
  run: "tick を定期実行（Ctrl+C で終了）",
  status: "状態・承認待ちを表示",
  approve: "gate を承認",
  answer: "agent の質問に回答",
  open: "Issue のタブを表示",
  issue: "Issue のディレクトリと段階を扱う（WORKFLOW.md から呼ぶ）",
  wt: "herdr の worktree を扱う（WORKFLOW.md から呼ぶ）",
  watch: "本番ログの承認待ち・エラーを待って JSON で表示",
  reject: "対象外にして停止（gate 省略可）",
  retry: "試行回数を戻して再開",
  stop: "所有するエージェントを停止",
  lock: "資源ロックを取得・解放・表示",
  logs: "イベントログを表示",
  init: "テンプレートから WORKFLOW.md・worktree の設定・スキルを作る",
  validate: "WORKFLOW.md の設定を検証",
};
export const notes: Record<string, string> = {
  tick: "例: flow tick --dry-run\n関わる gate: 各 step の gate_before / gate_after、base_changed、adopt_workspace",
  run: "例: flow run --interval 60 --dry-run\n関わる gate: tick と同じ。Ctrl+C では作業中のエージェントを停止しません。",
  status: "例: flow status 3170 --json\n関わる gate: 現在の承認待ちを表示",
  approve:
    "例: flow approve 3620 assign\n例: flow approve 3620 base_changed --choice keep\n選択肢: ng_action=copilot|self|stop、base_changed=keep|retarget、operation_recovery=applied|retry、skippable な step の開始 gate（finish_start など）=skip、cleanup=keep（worktree を消さない）\n関わる gate: start、verify_start、finish_start、assign、repro_result、issue_push、pr_body、cleanup、adopt_workspace、db_reset。agent_question は flow answer で回答。",
  answer: '例: flow answer 3170 "回答"\n関わる gate: agent_question',
  open: "例: flow open 3170\n関わる gate: なし",
  issue:
    "例: flow issue dir 3170\n関わる gate: なし。Issue のディレクトリは環境変数 ISSUE_DIR（メインのチェックアウトからの相対パス）の下。サブコマンド: dir・mark・push・status",
  wt: "例: flow wt list\n関わる gate: なし。設定はメインのチェックアウトの .herdr/worktree.json。サブコマンド: create・list・ports・sync・remove・stop・agent・hook",
  watch:
    "例: flow watch --prime\n例: flow watch --timeout 600\n関わる gate: なし。承認待ち（action）・エラーの新しいイベントを返す。読み取り位置だけを .flow/run/watch.json に保存",
  reject:
    "例: flow reject 3170 finish_start --reason 確認中\n関わる gate: gate を省略すれば gate が無くても対象外にできる。running の agent は停止してから stopped。段階を stage_store.rejected（対象外）へ変更。ディレクトリが無ければ作成",
  retry: "例: flow retry 3170\n関わる gate: 承認をリセット。reject 前の段階を復元し、再開時に開始 gate を再確認",
  stop: "例: flow stop 3170\n関わる gate: 承認待ちも停止。worktree は削除しません。",
  lock: "例: flow lock acquire db:exclusive --issue 3170 --wait --timeout 60000\n関わる gate: db_reset が manual の場合は排他取得前に承認",
  logs: "例: flow logs 3170 --follow\n関わる gate: 承認待ちの通知も記録",
  init: "例: flow --project ~/projects/app init\n関わる gate: なし。既にあるファイルは上書きせず飛ばす。スキルは .agents/skills/ にコピーし、.claude/skills/ からリンク",
  validate: "例: flow validate\n関わる gate: 設定の定義を検証。操作は実行しません。",
};

notes["lock acquire"] = notes.lock!;
notes["lock release"] =
  "例: flow lock release db:exclusive --issue 3170\n関わる gate: なし。指定した Issue の資源ロックを解放";
notes["lock list"] = "例: flow lock list\n関わる gate: なし。現在のロックを表示";

const titles: Record<string, string> = {
  "Usage:": "使い方:",
  "Arguments:": "引数:",
  "Options:": "オプション:",
  "Global Options:": "共通オプション:",
  "Commands:": "コマンド一覧:",
};
const placeholders: Record<string, string> = { options: "オプション", command: "コマンド", arguments: "引数" };
// These are Help's individual rendering hooks, before Commander lays out the help.
function styleSyntax(part: string): string {
  return part.replace(/\[(options|command|arguments)\]/g, (_match, key: string) => `[${placeholders[key]}]`);
}
export function localize(command: Command, io: Pick<CliServices, "output" | "error" | "view" | "errorView">): Command {
  const view = io.view ?? new Output({ isTTY: false });
  let errorHelp: string[] | undefined = [];
  return command
    .helpOption("-h, --help", "ヘルプを表示")
    .hook("preAction", () => {
      errorHelp = undefined;
    })
    .showSuggestionAfterError(false)
    .showHelpAfterError(true)
    .configureHelp({
      helpWidth: Math.min(100, io.view?.columns ?? 100),
      displayWidth: stringWidth,
      styleTitle: (title) => view.heading(titles[title] ?? title),
      styleUsage: styleSyntax,
      styleSubcommandTerm: styleSyntax,
      optionDescription(option) {
        const choices = option.argChoices ? `（選択肢: ${option.argChoices.join("|")}）` : "";
        const value =
          option.defaultValue === false ? "無効" : option.defaultValue === true ? "有効" : option.defaultValue;
        const fallback = value === undefined ? "" : `（既定: ${value}）`;
        return option.description + choices + fallback;
      },
    })
    .configureOutput({
      getOutHasColors: () => view.colors.isColorSupported,
      getErrHasColors: () => (io.errorView ?? view).colors.isColorSupported,
      writeOut: (text) => io.output(text.trimEnd()),
      writeErr: (text) => {
        if (errorHelp) errorHelp.push(text);
        else io.error(text.trimEnd());
      },
      // Commander writes its help before exitOverride provides the error code.
      // Hold only that native output, so the translated error still appears first.
      outputError: () => {
        errorHelp = [];
      },
    })
    .exitOverride((error: CommanderError) => {
      if (error.exitCode !== 0) {
        io.error(`引数または実行のエラー: ${errorMessage(error, command)}`);
        if (errorHelp) io.error(errorHelp.join("").trimEnd());
      }
      errorHelp = undefined;
      throw error;
    });
}
