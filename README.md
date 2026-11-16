# flow

GitHub Issue の処理を Herdr のエージェントや Copilot に振り分け、承認・進捗・再試行を管理する CLI です。プロジェクトごとの作業手順は `WORKFLOW.md` で定義します。

## 主な機能

- GitHub Issue の取得と、設定した段階に応じた作業の割り振り
- Herdr のエージェントや worktree の起動・管理
- 承認待ち、質問、失敗時の再試行と復旧
- 状態・ログの表示と dry-run による実行予定の確認

## インストール

### 必要な環境

- Linux または macOS、Bash
- [mise](https://mise.jdx.dev/) と [Herdr](https://herdr.dev/)
- Node.js 24 以上（下記の mise タスクでは 24.22.1 を使用）
- GitHub CLI (`gh`) と対象リポジトリにアクセスできる認証
- 同梱の `flow issue` / `flow wt` を使う場合：git、`jq`、`ss`（iproute2）、`column`
- `WORKFLOW.md` で指定するコマンド、エージェント、スキルなど

Herdr を使う step では、対象プロジェクトに対応する Herdr セッションが必要です。使用する workflow によって、Copilot やプロジェクト固有の mise タスクなども必要になります。

### GitHub Releases

GitHub Releases の `flow-universal.tar.gz` を mise で導入できます。アーカイブには CLI と実行時の JavaScript 依存が含まれます。Node.js は別途必要です。

対象プロジェクトの `mise.toml` に次を追加し、バージョンを公開済みの Release に合わせて変更してください。

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

mise タスクは flow 用に Node.js を選択し、引数をそのまま CLI に渡します。flow 本体は mise の管理領域に置かれ、各プロジェクトの設定・状態は対象プロジェクトの `.flow/` に保存されます。

## クイックスタート

1. [テンプレート](templates/)を参考に、対象プロジェクトに `.flow/WORKFLOW.md` を用意します。設定の詳細は[設定](#設定)を参照してください。
2. 対象プロジェクトに対応する Herdr セッションを起動します。
3. 設定と実行予定を確認します。

```sh
mise run flow validate
mise run flow tick --dry-run
mise run flow status
```

`validate` は設定を検証します。`tick --dry-run` では予定を確認できますが、読み取りコマンドの実行や dry-run 用の記録は行います。出力を確認したうえで、Herdr セッション内から運用を開始してください。

```sh
mise run flow run
```

`run` は tick を繰り返します。Ctrl+C で停止すると、実行中の tick を完了してから終了します。

## 同梱のコマンドとスキル

flow だけで運用できるよう、Issue ディレクトリと worktree を扱うコマンド、監視コマンド、運用スキルを同梱しています。

- **`flow issue <dir|mark|push|status>`**：Issue ごとのディレクトリ `<ISSUE_DIR>/<並び順>-<段階>_<番号>` を扱います。`ISSUE_DIR`（メインのチェックアウトからの相対パス）を環境変数で渡してください（例：利用先の mise の `[env]`）。段階の並びは `ISSUE_STATUSES`（空白区切り）で変えられます。`push`・`status` は既定の段階名（未着手・再現済・Issue更新済・修正中・完了）を使います
- **`flow wt <create|list|ports|sync|remove|stop|agent|hook>`**：Herdr の worktree を作り、メインのチェックアウトの `.herdr/worktree.json`（`sync`・`slot_step`・`services`・`env_files`・`hooks`）に従ってファイルのコピー・ポートの割り当て・フックを行います。設定の形式は [tools/lib/wt.sh](tools/lib/wt.sh) の先頭にあります
- **`flow watch`**：本番ログの承認待ち・エラーを待ち、JSON で返します。運用スキルが使います
- **`skills/flow-operator/`**：メインのエージェントが `flow run` を横のペインで動かし、承認待ち・質問をユーザーに示して操作するスキルです。利用先の `.claude/skills/`（または `.agents/skills/`）にリンクかコピーしてください。並列で進めても、メインのエージェントとの会話だけを見ていれば済むようになります

[テンプレート](templates/WORKFLOW.md)は Issue ディレクトリと worktree の操作にこれらのコマンドを使います。flow が実行するコマンドからの `flow` は、実行中の flow と同じ版・同じ Node.js になります。

質問待ちは `flow status <issue>` で確認し、`flow answer <issue> "回答"` で回答できます。`flow open <issue>` は agent のタブへ移動します。操作後は実行中の `flow run` がすぐ tick します。通知はテンプレートの `herdr notification show {title} --body {body} --sound {sound}` を利用でき、音は action・error が request、info が none です。

## コマンド

| コマンド                          | 操作                                 |
| --------------------------------- | ------------------------------------ |
| `mise run flow status`            | Issue の状態と承認待ちを表示         |
| `mise run flow status 123`        | Issue 123 の詳細を表示               |
| `mise run flow tick`              | tick を一度実行                      |
| `mise run flow run`               | tick を定期実行                      |
| `mise run flow approve 123`       | 現在の gate を承認                   |
| `mise run flow reject 123`        | 対象外として停止                     |
| `mise run flow retry 123`         | 試行回数を戻して再開                 |
| `mise run flow stop 123`          | flow が所有するエージェントを停止    |
| `mise run flow answer 123 "回答"` | agent の質問に回答                   |
| `mise run flow open 123`          | agent のタブへ移動                   |
| `mise run flow watch`             | 承認待ち・エラーを待って JSON で表示 |
| `mise run flow issue dir 123`     | Issue 123 のディレクトリを表示       |
| `mise run flow wt list`           | worktree の一覧を表示                |
| `mise run flow logs`              | イベントログを表示                   |
| `mise run flow logs --follow`     | 新しいログを追跡                     |
| `mise run flow lock list`         | ロックの状態を表示                   |

`mise run flow --help` で全コマンド、`mise run flow approve --help` などで各コマンドの引数と選択肢を確認できます。JSON が必要な場合は `mise run flow status --json` を使います。

承認時に選択が必要な gate もあります。例えば、base の変更を確認した後、固定済みの base を維持するには次のように指定します。

```sh
mise run flow approve 123 base_changed --choice keep
```

エージェントからの質問（`agent_question`）には `flow answer` で回答します。権限の確認などの選択式の画面は、`flow open` でペインへ移動して回答します。`approve` が回答を代行することはありません。

## 設定

対象プロジェクトに `.flow/WORKFLOW.md` を作成します。YAML front matter に tracker、stage store、worktree、エージェント、承認、step などを設定し、本文に `## prompt: <step>` を記述します。`vars.main` は対象プロジェクトの絶対パスに設定してください。

[WORKFLOW.md テンプレート](templates/WORKFLOW.md)と [mise 設定例](templates/mise.toml)、[Git 除外設定例](templates/gitignore)、[worktree 設定例](templates/worktree.json)を用意しています。WORKFLOW の `REPLACE` を含む値と未設定のコマンド（`base.resolve` など）、プロンプトを利用先に合わせて変更してください。テンプレートの未設定コマンドはエラーで終了します。`validate` は構文のみを検証し、設定漏れや外部コマンドの動作は確認しません。

設定形式と各項目は [仕様書](SPEC.md) を参照してください。[テスト用の WORKFLOW.md](test/fixtures/WORKFLOW.md) は特定プロジェクトのタスクやスキルを前提にしたフィクスチャです。

flow 本体は GitHub・Herdr との連携や状態管理を提供します。Issue ディレクトリと worktree は同梱のコマンドを使えます（別の方法で管理するなら `WORKFLOW.md` のコマンドを差し替えます）。DB などの操作コマンドと作業手順は利用先で用意し、`WORKFLOW.md` に指定します。設定の置き場所、必須コマンド、一元化の進め方は [導入時の設定](docs/integration.md) にまとめています。

## 状態とログ

| 場所                         | 内容                                                 | 取り扱い                                  |
| ---------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| `.flow/WORKFLOW.md`          | プロジェクト固有の設定                               | プロジェクトに合わせて管理                |
| `.flow/state/`               | 所有記録、ロック台帳、Issue 一覧、正常だった設定など | 永続データ。削除しない                    |
| `.flow/run/`                 | 実行中の PID・ロック、dry-run の一時データなど       | flow の停止中に不要な一時データを整理可能 |
| `.flow/logs/`                | 日付ごとのイベントログ                               | 必要に応じて古いログを整理可能            |
| `<Issue ディレクトリ>/flow/` | Issue ごとの状態とエージェントの結果                 | 永続データ。削除しない                    |

`state/`、`run/`、`logs/` は利用先プロジェクトの Git 管理から除外してください。`WORKFLOW.md` はプロジェクトの運用に合わせて管理してください。

flow は自分が所有すると記録した worktree・エージェントだけを操作します。承認や復旧の操作を行う際は、表示された対象と現在の Herdr・GitHub の状態を確認してください。

## 更新

1. `flow run` を停止し、実行中の tick が終了するのを待ちます。
2. `.flow/state/` と Issue ごとの `flow/` を保持し、更新先バージョンの状態互換性を確認します。
3. 利用先の `mise.toml` でバージョンを更新し、`mise install` を実行します。
4. `mise run flow validate` と `mise run flow tick --dry-run` で設定と予定を確認してから再開します。

旧版と新版の flow を同時に起動しないでください。

## ドキュメント

- [仕様書](SPEC.md)：設定形式と動作の詳細
- [導入時の設定](docs/integration.md)：必須項目と既存環境の使用例
- [ガイド](GUIDE.md)：特定プロジェクトのタスクやスキルを使った運用例

## 開発

このリポジトリの開発には、`.node-version` に指定された Node.js と `package.json` の `packageManager` に指定された pnpm を使用します。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm typecheck
pnpm test
```

`pnpm test` はテスト前に CLI とテスト用フィクスチャをビルドします。`pnpm exec vp test` を直接実行すると事前ビルドが省略されるため、通常は `pnpm test` を使用してください。

Release 作成時は `package.json` のバージョンに一致する `v` 付きタグを push します。GitHub Actions がチェック・テストとアーカイブの動作確認を行い、GitHub Release に成果物を添付します。ローカルでは `pnpm build` と `./scripts/package-release.sh` でアーカイブを生成できます。

## ライセンス

[MIT License](LICENSE)
