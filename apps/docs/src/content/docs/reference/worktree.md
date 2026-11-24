---
title: .herdr/worktree.json
description: 同梱の worktree コマンドが利用する同期・ポート・フックの設定
---

メインチェックアウトの `.herdr/worktree.json` を、同梱の `flow wt` が読みます。[設定例と検証規則](/reference/worktree-schema/)も参照してください。

| キー                           | 型と実行時の意味                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync`                         | コピーする相対パス・glob の文字列配列。ディレクトリは末尾 `/` を付け、コピー先を置き換えます。絶対パスや `..` は不可。                                     |
| `slot_step`                    | `services` がある場合に必要な数値。ポートの増分です。                                                                                                      |
| `services.<name>.port`         | 基準ポートの数値。名前には英数字、`_`、`-` を使えます。実ポートは基準ポート + slot × slot_step です。メインは slot 0。                                     |
| `env_files`                    | `file`、`key`、`value`（すべて文字列）のオブジェクト配列。`{web}` のようにサービス名をポートへ展開します。ファイルが存在すればキーを更新または追記します。 |
| `hooks`                        | フック名をシェルコマンドの配列に対応付けます。各コマンドをチェックアウト直下で順に実行します。                                                             |
| `services.<name>.cmd`、`serve` | 指定する場合は文字列です。現在の同梱サブコマンドはこれらを使って開発サーバーを起動しません。                                                               |

`post_sync` は同期とポート反映後、`post_create` は `flow wt create` の同期後、`pre_remove` は worktree 削除前です。`pre_serve` は `flow wt hook pre_serve` で明示的に呼べます。フックには `WT_PATH`、`WT_MAIN`、`WT_SLOT` と、該当する `WT_PORT_<サービス大文字>` が公開されます。ハイフンはアンダースコアへ変換されます。

slot は worktree の `.ports.env` に保存されます。worktree のポート再計算には [flow wt ports](/reference/cli/wt/ports/)、コピーと同期には [flow wt sync](/reference/cli/wt/sync/) を使います。ポートを変更した場合、実行済みのサーバーは新しい設定で起動し直してください。
