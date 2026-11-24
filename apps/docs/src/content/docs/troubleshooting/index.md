---
title: トラブルシューティング
description: 導入、検出、起動、承認、worktree、状態とロックの問題を調べる
---

## `flow` が見つからない

`mise install` 後、対象プロジェクト内で `mise run flow --help`。Release アセット名、`bin_path`、Node.js のバージョンを [インストール](/getting-started/install/) と照合。

## `WORKFLOW:` から始まるエラー

`flow validate` で現在のファイルを検証。YAML、未定義 Gate、prompt 名、重複段階、絶対パス、変数の綴りを [設定項目一覧](/reference/workflow-schema/) と確認。

## Issue が検出されない

`gh auth status`、`gh issue list --assignee @me --state open` を対象チェックアウトで確認。検索条件、除外・保留ラベル、保存済みの対象外 Stage を調べ、`flow tick --dry-run` を再実行。

## `base.resolve` で失敗

テンプレートの未設定値を差し替え、使うコマンドをメイン側から実行して stdout の1行目を確認。既存 PR の base が変わった場合は `base_changed` を調べる。

## エージェントが起動しない

Herdr の対象 workspace 内で実行しているか、名前が妥当か、他のエージェントが使うペインではないかを確認。信頼確認や対話の待機は `flow open 123` または Herdr の該当タブで確認。

## 承認待ちが続く

`flow status 123` で Gate の名前、成果物、選択肢を再確認。質問は `flow answer`。監視を止めているなら `flow run` を再開するか `flow tick` で処理。

## 完了条件が成立しない

現在の Issue ディレクトリを `flow issue dir 123` で調べ、試行番号と結果、成果物、Stage、PR の状態を照合。

## worktree 同期・削除に失敗

`flow wt list` の workspace ID、Git の未コミット変更、フック出力、`.herdr/worktree.json` を確認。所有や未保存変更を解決してから再試行。

## ポート競合、slot 不足

`flow wt list` と `flow lock list` で使用中の環境を特定。使われているポートと同じ slot を重ねず、[同期と並列実行](/guides/worktrees/)を確認。

## ロックまたは別プロセス実行中

別の run・tick・watch が動いているか確認。資源競合は `flow lock list` と作業ペインを突き合わせ、利用を終えた正しい Issue のロックを解放。動作中の PID や永続台帳を手動削除しない。

## 外部操作の結果が不明

ログと実際の Issue・PR・ペインを確認し、[復旧 Gate](/guides/recovery/#外部操作の結果が不明な場合)で引き継ぐ。

診断には、該当 Issue の `flow status 123` と `flow logs 123`、今日以外なら `flow logs 123 --date YYYY-MM-DD` を使います。外部へログを共有する場合は、環境固有のパスや秘密情報を除いてください。
