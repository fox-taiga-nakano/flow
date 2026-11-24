---
title: インストール
description: Node.js、mise、GitHub CLI、Herdr と公開アーカイブの準備
---

## 必要な環境

- Linux または macOS、Bash、Node.js 24 以上。
- `mise` と Git。以下はプロジェクト単位で CLI を固定する手順です。
- `gh` と対象リポジトリへのアクセス権。利用する Step に応じて Issue 編集・PR 編集・コメント・Copilot アサインの権限も必要です。
- Herdr と `WORKFLOW.md` に指定したエージェント。テンプレート例では Claude Code と GitHub Copilot を使用します。
- 同梱の補助コマンドを使う場合、`jq`、`column`、開発ポートの確認に `ss`（iproute2）。`ss` を使う操作はコマンドを利用できる環境で実行してください。

## Release アーカイブを mise で導入する

対象プロジェクトの `mise.toml` に追加します。バージョンは公開済みの例です。利用するタグの内容と最新リリースは [GitHub Releases](https://github.com/fox-taiga-nakano/flow/releases) で確認できます。

```toml
[tools]
"github:fox-taiga-nakano/flow" = { version = "0.1.0", asset_pattern = "flow-universal.tar.gz", bin_path = "bin" }

[tasks.flow]
tools.node = "24.22.1"
raw_args = true
run = "flow"
```

```sh
mise install
mise run flow --help
```

flow の日本語のヘルプが表示されれば CLI を呼び出せています。アーカイブには CLI、実行時の依存、テンプレート、スキル、補助コマンドが入っています。実行用の Node.js は mise タスクが用意します。このサイトの例では `mise run flow` を `flow` と表記します。操作が利用中のリリースにあるかどうかは、そのバージョンのヘルプでも確認できます。

## GitHub と Herdr を準備する

対象のメインチェックアウトで実行します。

```sh
git remote get-url origin
gh auth status
gh repo view --json nameWithOwner
herdr --help
```

`gh auth status` で利用するアカウントを確認し、対象リポジトリを開けるようにします。認証が必要なら `gh auth login` を実行します。Herdr のセッションでメインの workspace を開き、そこで flow を実行してください。テンプレートに含まれるメイン上の Step は Herdr のペインからの実行が必要です。

次は [クイックスタート](/getting-started/quickstart/)で設定を作成します。
