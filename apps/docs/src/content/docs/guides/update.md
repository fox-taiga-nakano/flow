---
title: flow を更新する
description: Release 版の更新と設定・状態の引き継ぎ
---

1. [GitHub Releases](https://github.com/fox-taiga-nakano/flow/releases) で対象バージョンの変更内容と移行手順を読みます。
2. `flow run` を Ctrl+C で止め、稼働中のエージェントを `flow status` で確認します。必要に応じて [Issue を停止](/guides/recovery/)します。
3. `WORKFLOW.md`、`.herdr/worktree.json`、`.flow/state/`、Issue ごとのディレクトリを保持し、必要ならバックアップします。
4. `mise.toml` の flow バージョンを上げて `mise install`。旧配置から移す場合は、設定に残る旧タスク名や絶対パスをレビューします。起動時の移行元と移行先の両方に台帳がある場合は、内容を確認してどちらの状態を継ぐか判断します。
5. `flow validate`、`flow status`、`flow tick --dry-run` で設定、所有情報、次の操作を確認してから `flow run` を再開します。

`flow init` は既存設定とスキルをスキップします。新しい設定例は利用するタグの `templates/` と比較し、プロジェクト側で取り込みます。
