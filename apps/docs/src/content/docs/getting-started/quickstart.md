---
title: クイックスタート
description: flow init から設定の検証、実行予定の確認、初回起動まで
---

[インストール](/getting-started/install/)を済ませ、対象リポジトリのメインチェックアウトを Herdr で開きます。

## 1. 初期ファイルを作る

```sh
flow init
```

`init` は `.flow/WORKFLOW.md`、`.herdr/worktree.json`、`.agents/skills/flow-*` を配置し、`.claude/skills/` からリンクします。ファイルが存在する場合は各項目をスキップします。git の origin を解釈できれば初期の `vars.owner` と `vars.repo` を埋めます。

## 2. プロジェクトに合わせる

1. `WORKFLOW.md` の `vars.main`、`owner`、`repo` を確認します。
2. `base.resolve` をマージ先のブランチ名を1行目に出力するコマンドに置き換えます。テンプレートの値は未設定を明示して失敗します。
3. 同梱の Issue 操作を使う場合、`ISSUE_DIR` を設定します。たとえば `[env]` で `ISSUE_DIR = "app-issues"` とします。同梱スクリプトではメインチェックアウトの親ディレクトリ配下に解決します。
4. ローカル実行情報を Git 管理から外すため、`/.flow/state/`、`/.flow/run/`、`/.flow/logs/` を `.gitignore` に追加します。
5. worktree の同期・ポート・フックと、スキルの開発サーバー、テスト、成果物の手順を調整します。認証は CLI の実行環境に設定します。

[Workflow の設定](/reference/workflow/)と [worktree 設定](/reference/worktree/)に、コマンドが返す形式と置き場所があります。

## 3. 設定と実行予定を確認する

```sh
flow validate
flow tick --dry-run
```

`✔ WORKFLOW.md: valid` が出たら、構文と検証条件を満たしています。dry-run では GitHub・Herdr の読み取りが行われ、外部の変更操作は `SKIPPED` と表示されます。予定や診断ログは残ります。候補が空なら GitHub アカウント、Issue の担当とラベル、検索条件を確認します。

## 4. 起動する

```sh
flow run
```

テンプレートの未着手 Issue では `start` の承認待ちを確認できます。成果物や承認コマンドの見方は [実行画面](/guides/run/)と [承認操作](/guides/approval/)へ進みます。ループを終えるには Ctrl+C を押します。
