---
title: WORKFLOW.md
description: 設定ファイルの構造、検証規則、外部コマンドとプロンプトの契約
---

`.flow/WORKFLOW.md` は YAML front matter と `## prompt: <step>` の節で構成します。スキーマは [Workflow 設定項目一覧](/reference/workflow-schema/) にあります。

## 対象の選択

| 設定                                        | 実行時の意味                                                                                                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                                   | 現在は整数の `1`。                                                                                                                                                                            |
| `timezone`                                  | IANA タイムゾーン。省略時の時刻表示は Asia/Tokyo。ログの日別ディレクトリは表示設定にかかわらず日本時間です。                                                                                  |
| `tracker`                                   | `kind: github`。文字列の `query` は `assignee`、`state`、`label`、`search`、`milestone`、`author` に対応します。`exclude_labels` は一致した候補を除外。`pr_limit` は PR 一覧の上限で既定100。 |
| `tracker.hold_labels` と `stage_store.held` | 両方を設定します。対象ラベルが付いた Issue は、進行中の作業を止めず、次に開始できる境界で保留に移します。解除後は元の段階へ。                                                                 |
| `base.resolve`                              | マージ先ブランチを stdout の1行目に返す空でないコマンド。関連 PR の既存 base を観測し、固定後の変更は manual の `base_changed` で確認します。                                                 |
| `vars`                                      | `main` はメインチェックアウトの絶対パス。値は文字列または数値。`owner` と `repo` は Issue リンクやテンプレートの Copilot アサインに使います。                                                 |

## ローカルツールとの契約

- **stage_store** は `kind: dirs`。`initial` と空でない別名の `rejected` が必須です。`order` は表示順です。空・重複・パス区切りを含む名前を避けます。
- **stage_store.commands** の `dir` は Issue ディレクトリのパスを、`ensure` は必要なら作成してパスを返します。`set` は段階を変更します。任意の `get` で段階を返せます。省略時は `pattern` の第1キャプチャを使います。
- **workspace** は `kind: herdr`。`commands.list` は workspace ID、slot、branch、path のタブ区切り。`create_for_branch`、`create_from_base`、`sync`、`remove` は空でないコマンド文字列が必須です。`assign_slot` は slot を作業環境の設定へ反映する任意コマンドです。
- **runner** は `kind: herdr`。`close_on_complete` は既定で true。完了時に所有を確認してエージェントを終了します。起動コマンドを `runner.commands` で上書きする方式は廃止されています。
- **notifier** は `kind: command`。任意の `command` に通知先を設定できます。テンプレートでは Herdr の通知を使い、タイトル、本文、音を参照します。
- **database** を使う場合は空でない `stop`、`reset.snapshot`、`reset.seed` のコマンドをすべて設定します。Step に `db_reset: true` を置くには worktree のローカルエージェント、`db:shared` ロック、`db_reset` Gate が必要です。

外部コマンドは Bash で実行します。stdout を読み取るコマンドの診断は stderr に出し、失敗時は非ゼロの終了コードを返します。読み取りとして呼ばれるコマンドは副作用なしにします。

## Step と Gate を設定する

`steps` は名前から定義へのマップで、1件以上必要です。段階起動には重複しない `when_stage` を使います。`when_pr_review_requested` と `when_pr_merged: true` はそれぞれ1件までです。`agent`、`remote`、`action` は1種類だけ指定します。

テンプレートの `steps.cleanup.when_pr_review_requested` には、`[alice, bob]` のように GitHub ユーザー名を指定します。関連する open PR の現在のレビュー依頼先に1人でも含まれると起動します。空の配列なら cleanup は無効です。`steps.complete` は関連 PR のマージを検出すると Issue の段階を「完了」にします。

既存の設定を移行する場合は、`cleanup` の `when_pr_merged` を `when_pr_review_requested` に置き換え、`cleanup` のアクションを `{ remove_workspaces: true }` にします。テンプレートの `complete` を追加して、マージ時に段階を更新します。

- **agent** は `claude` または `codex`。展開後の名前は `flow-` に続けて小文字の英数字・`_`・`-` を1〜27文字。対応する名前のプロンプトが必要です。
- **workspace** は `none`、`{ pr: true }`、`{ from_base, branch }`、`{ reuse: 'flow/repro-{issue}' }` のいずれかです。`reuse` は同じ Issue が所有する指定ブランチの worktree を使い、見つからなければメインで実行します。worktree を使う場合は `adopt_workspace` Gate を定義します。
- **remote** は `kind: copilot`。`assign` には `{assign_body}` が必要です。`transport` の REST / GraphQL はアサイン本文の形式を選びます。`authors`・`done_when` は Step ごとの値を優先できます。完了条件は `timeline`、`review_requested`、`not_draft` のいずれかです。
- **action** にはコマンドまたは `remove_workspaces: true` を指定します。削除は所有する worktree が対象です。
- **done_when** の `files` は Issue ディレクトリ内の相対パス。`stage_in` は許可する完了段階です。ローカル Step では結果ファイルも確認します。
- **gates** は名前を `manual` または `auto` に対応付けます。参照する `gate_before`、`gate_after`、`on_ng.gate` は定義が必要です。`base_changed` は manual 固定です。
- **on_approve** は `command` または `prompt` のいずれか。`skippable` を有効にするには開始 Gate が必要です。`on_ok`、`on_ng`、`on_done` は実行結果に応じて段階変更、停止、通知、worktree 削除などを設定します。
- **remote.ng_action** は Copilot に修正を依頼するコマンドと戻す Stage を設定します。`gates.ng_action: auto` には `remote.ng_action.choice` に `copilot`、`self`、`stop` のいずれかが必要です。

## 並列数、リトライ、ロック

`concurrency.global` と `concurrency.per_step` は正の整数です。`retry.max_attempts` は正の整数、`retry.backoff_ms` は0以上のミリ秒値の空でない配列です。`stall_ms` は正の整数のミリ秒値です。

`locks.slots` は重複しない正の整数。`locks.resources` では英数字、アンダースコア、ハイフンで資源を命名し、`kind: rw` を指定します。Step の `locks` には `slot` と、定義済み資源の `<名前>:shared` または `<名前>:exclusive` を指定できます。

## プロンプトと結果

`{issue.number}`、`{pr.branch}`、`{ws.path}`、`{vars.main}`、`{attempt}`、`{flow_dir}` などを、利用できる処理の文脈で展開します。未定義の名前は設定検証でエラーになります。シェル変数の `${VAR}` はシェル側の式です。

ローカルエージェントは Issue ディレクトリ内の `flow/result-<step>-<attempt>.json` を書きます。結果は `ok`、`ng`、`blocked`、`failed`、要約は `summary`、成果物は `artifacts` の配列、質問は任意の `needs` です。実行状態は flow が保存します。

```json
{
  "result": "ok",
  "summary": "設定画面の表示を確認しました",
  "artifacts": ["evidence/after/checks.tsv"]
}
```
