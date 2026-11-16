# 導入時の設定

flow の設定に必要な項目と、`example-app` での使用例をまとめます。実例のタスク名や段階名は flow に組み込まれていません。別のプロジェクトでは、使用するツールと作業手順に合わせて設定してください。

## 管理する場所

設定は役割ごとに次の場所へ集約するのが、このプロジェクトで推奨する構成です。[テンプレート](../templates/)を用意していますが、自動生成や共通コマンドの同梱は行っていません。

| 管理するもの                                                                | 持ち主・置き場所                                               | 理由                                                            |
| --------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------- |
| flow の実行ファイル、GitHub・Herdr 連携、承認・状態管理、コマンド引数の展開 | flow 本体・Release                                             | どのプロジェクトでも共通の動作として提供する                    |
| flow と Node.js のバージョン、`mise run flow` の入口                        | 利用先の mise 設定                                             | プロジェクトごとにバージョンを固定し、既存の Node.js と分離する |
| Issue の選択、段階、step、gate、プロンプト、外部コマンドの指定              | 利用先の `.flow/WORKFLOW.md`                                   | プロジェクトの運用に合わせる設定を一か所に集める                |
| Issue ディレクトリ・worktree・DB・ブラウザなどを操作する実際のコマンド      | 利用先のリポジトリまたは明示的に管理する共通ツール             | flow はコマンドを実行するが、現時点ではこれらの実装を同梱しない |
| GitHub トークンやその他の秘密情報                                           | 利用者・実行環境の認証設定                                     | `WORKFLOW.md` やリポジトリには書かない                          |
| 所有・ロック・実行履歴・ログ                                                | 利用先の `.flow/state/`・`run/`・`logs/` と Issue ディレクトリ | 設定とは別の実行時データ。更新時に保持する                      |

`.flow/WORKFLOW.md` を **作業手順と呼び出すコマンドの正本**にし、コマンドの実装はプロジェクト内の mise タスクやスクリプトで管理します。実装まで単一ファイルにまとめる必要はありません。`~/.config/mise` にしかないタスクを参照すると、別の利用者や環境で再現できないため、必要なタスクはプロジェクト内へ移すか、別途バージョン固定して導入するのが望ましい構成です。

## 必要なコマンドと提供元

以下は現在の実装に基づきます。「条件付き」は該当する step や運用を使う場合に必要です。`validate` が通っても、外部コマンドの存在・認証・実際の動作までは保証されません。

| コマンド・機能                                                                       | 条件                                                                      | 提供元と設定                                                                                          |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `node`、`/bin/bash`                                                                  | flow の実行に必要                                                         | 利用環境。Release の CLI は Node.js 24 以上                                                           |
| `gh`                                                                                 | GitHub の Issue・PR の取得時。Copilot や PR 操作では追加の権限も必要      | 利用環境が用意し、flow の GitHub アダプターが呼び出す                                                 |
| `herdr`                                                                              | Herdr の workspace・agent を使う場合                                      | 利用環境が用意し、flow の Herdr アダプターが呼び出す                                                  |
| `git`                                                                                | worktree の状態確認や、`base.resolve` などの設定された Git 操作を使う場合 | 利用環境。flow とプロジェクトのコマンドが呼び出す                                                     |
| `mise`                                                                               | README の導入方法や、`WORKFLOW.md` に `mise` タスクを指定する場合         | 利用環境。flow 本体の外部コマンド管理を代替しない                                                     |
| `stage_store.commands.dir`・`ensure`・`set`                                          | 現在の設定検証で必須                                                      | 同梱の `flow issue`（テンプレートの既定）か、利用先の実装を `WORKFLOW.md` で指定                      |
| `workspace.commands.list`・`create_for_branch`・`create_from_base`・`sync`・`remove` | 現在の設定検証で必須                                                      | 同梱の `flow wt`（テンプレートの既定）か、利用先の実装を `WORKFLOW.md` で指定                         |
| `workspace.commands.assign_slot`、`stage_store.commands.get`                         | その機能を使う場合                                                        | 同梱の `flow wt ports` か利用先の実装。未指定時はそれぞれ割り当て処理を省略、`pattern` から段階を取得 |
| `jq`、`ss`、`column`                                                                 | 同梱の `flow issue` / `flow wt` を使う場合                                | 利用環境                                                                                              |
| `base.resolve`                                                                       | 現在の設定検証で必須                                                      | 利用先が実装し、出力の 1 行目に base を返す                                                           |
| `database` の stop・reset、通知、step の action・承認後コマンド                      | 該当機能を使う場合                                                        | プロジェクトの DB や作業手順に合わせて利用先が実装                                                    |
| `jq`、`sed`、ブラウザ・DB ツールなど                                                 | 利用先のタスクやプロンプトが要求する場合                                  | 利用先が管理。flow の全利用者に共通の必須コマンドではない                                             |

Issue ディレクトリと worktree のコマンドは flow に同梱しています（`flow issue` / `flow wt`。README の「同梱のコマンドとスキル」）。別の方法で管理する利用先は、`WORKFLOW.md` のコマンドを差し替えてください。

## 一元化の進め方

1. **同梱のコマンドに揃える。** Issue ディレクトリと worktree は `flow issue` / `flow wt` を使い、`ISSUE_DIR` と `.herdr/worktree.json` を利用先で用意する。プロジェクト固有のポート、DB、開発サーバー、フックやプロンプト、段階のスキルは利用先に残す。
2. **運用スキルを置く。** `skills/flow-operator` を利用先の `.claude/skills/` などにリンクかコピーする。
3. **導入の初期化・診断を検討する。** テンプレートの自動配置や、設定済みコマンド・ツール・認証の読み取り専用チェックを flow 側で提供すると、初期設定と検証を揃えられる。現時点の `validate` は設定形式の検証であり、これらの診断やテンプレートの自動配置は未実装。
4. **互換性を確認して切り替える。** 既存の `.flow/` の設定と状態を保持し、旧版を停止したうえで、同じコマンド結果・所有記録・dry-run の予定を確認する。標準アダプターへの移行を自動的に行う機能は現在ありません。

## 共通の前提

- flow の実行環境には Node.js 24 以上と Bash が必要です。
- GitHub CLI (`gh`) は対象リポジトリにアクセスできる状態にします。Issue の取得だけでなく、設定に応じて Copilot のアサインや PR の操作にも使います。
- Herdr を使う step では、対象プロジェクトの Herdr セッション、設定されたエージェント、および実行する作業に必要な権限・スキルを用意します。
- `WORKFLOW.md` に指定するコマンドは利用先の環境で実行できる必要があります。flow が同梱するのは Issue ディレクトリと worktree のコマンドだけで、プロジェクト固有の mise タスク（DB・ブラウザなど）は提供しません。
- `.flow/WORKFLOW.md` と状態を置くプロジェクトのディレクトリ、Issue ごとのデータ、および `vars.main` の関係を確認します。`vars.main` はメインのチェックアウトを指す絶対パスです。

## WORKFLOW.md の必須設定

`.flow/WORKFLOW.md` は YAML front matter と `## prompt: <名前>` の本文で構成します。主な検証項目は次のとおりです。細かな形式と利用可能な変数は [仕様書](../SPEC.md) を参照してください。

[WORKFLOW.md テンプレート](../templates/WORKFLOW.md)は必須項目を含む構成例です。`REPLACE` を含む値、未設定コマンド、プロンプトを変更してください。未設定コマンドはエラーで終了します。テンプレートを変更せずに `validate` が通っても、利用できる設定であることは意味しません。

| 項目                        | 要件                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `version`                   | `1`                                                                                       |
| `tracker`                   | `kind: github`、文字列の `query`、配列の `exclude_labels`                                 |
| `stage_store`               | `kind: dirs`、異なる `initial` と `rejected`、`commands.dir`・`ensure`・`set`             |
| `workspace`                 | `kind: herdr`、`commands.list`・`create_for_branch`・`create_from_base`・`sync`・`remove` |
| `runner`                    | `kind: herdr`。`runner.commands` は使用しません                                           |
| `notifier`                  | `kind: command`、通知コマンドまたは `null`                                                |
| `concurrency`               | 正の整数の `global` と `per_step`                                                         |
| `locks`                     | 重複のない正の番号の `slots` と、`rw` 資源の `resources`                                  |
| `retry`・`stall_ms`         | 正の `max_attempts`、空でない `backoff_ms`、正の `stall_ms`                               |
| `gates`                     | 各 gate に `manual` または `auto` を指定。`base_changed` は `manual`                      |
| `vars.main`・`base.resolve` | メインの絶対パスと、base を取得する空でないコマンド                                       |
| `steps`                     | 1 件以上。起動条件と `agent`・`remote`・`action` のいずれか一つを指定                     |

agent の step には対応する `## prompt: <step名>` が必要です。step が参照する gate は `gates` に定義します。`tracker.hold_labels` と `stage_store.held` は使う場合に両方指定します。

DB リセットを使う step には `database.stop`、`database.reset.snapshot`・`seed`、`db_reset` gate、worktree の agent、`db:shared` ロックが必要です。これらは DB リセットを使わない workflow では必須ではありません。

## コマンドの契約

`stage_store.commands.dir` は Issue ディレクトリの絶対パスを返します。`ensure` は必要ならディレクトリを作り、その絶対パスを返します。`set` は段階を変更します。`get` を指定しない場合、flow は `pattern` の第 1 キャプチャから段階を読みます。

`workspace.commands.list` は worktree 情報を `workspace ID`、`slot`、`branch`、絶対パスのタブ区切りで返します。作成コマンドは worktree の絶対パスと workspace ID を返す必要があります。`assign_slot` は任意です。各コマンドは `vars.main` を作業ディレクトリとして実行されます。

コマンド中の `{issue}`、`{stage}`、`{path}`、`{workspace}`、`{branch}`、`{base}` などは、対応する実行時の値に置き換えられます。コマンドと使用する外部ツールの設定は、利用先プロジェクトで用意してください。

## example-app の使用例

調査した環境では、flow の旧版を対象プロジェクトの `.flow/` に置き、`.mise/conf.d/flow.toml` が `.flow/bin/flow` を起動しています。`.flow/WORKFLOW.md` の設定を現在の flow の `validate` に通し、構文上有効であることを確認しました。実際の tick、エージェント起動、GitHub 更新、DB 操作は実行していません。

この環境の主な依存は次のとおりです。

| 用途         | 使用している設定                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| Issue の段階 | `ISSUE_DIR=.dev/issues` と、同梱の `flow issue dir`・`mark`・`push`・`status`                              |
| worktree     | 同梱の `flow wt list`・`create`・`ports`・`sync`・`remove`、Herdr、および `.herdr/worktree.json`           |
| 作業手順     | `repro`・`refine`・`implement`・`verify`・`finish`・`cleanup`。段階名と成果物のパスはこのプロジェクト固有  |
| エージェント | Claude、`## prompt: guard`、`pr-verify`・`issue-refine`・`pr-finish` などのスキル                          |
| Copilot      | `gh`、対象リポジトリへの権限、`vars.owner`・`vars.repo`、REST アサインと `review_requested` による完了確認 |
| base         | `base.resolve` が Git の `origin` から `delivery/*` を読み取る設定                                         |
| DB・ブラウザ | `flow wt stop`、`db:reset --snapshot` / `--seed`、`pw:repro` など。DB リセットを使う step に必要           |

Issue ディレクトリと worktree のコマンドは flow 同梱のものです。`.herdr/worktree.json`、DB・ブラウザのタスク、プロンプトに書かれたスキル・ファイルは利用先で用意します。

## 旧配置から Release 版へ移す場合

flow の実行には Node.js 24 以上が必要です。

既存の `.mise/conf.d/flow.toml` は `.flow/bin` を PATH に加え、`mise run flow` も旧版を直接呼びます。Release 版をインストールするだけでは切り替わらないため、タスクと PATH の設定を更新し、`mise run flow --help` で実際の入口を確認してください。旧版のファイルと `.flow/WORKFLOW.md`、`state/`、`run/`、`logs/` は同じ `.flow/` にあります。ディレクトリごと削除・置換せず、runner を止めて状態と Issue ごとのデータを保持したうえで移行します。

切り替え後は `mise run flow validate`、`mise run flow tick --dry-run`、`mise run flow status` の順に確認します。dry-run は外部への変更を予定として扱いますが、読み取りコマンドの実行と dry-run 用の記録は行います。旧版と新版を同時に起動せず、状態の互換性と所有記録を確認してから再開してください。
