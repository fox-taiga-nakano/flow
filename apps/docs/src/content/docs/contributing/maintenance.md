---
title: 開発・更新・リリース
description: コマンド、設定、図、端末デモの変更をローカルと CI で検証する
---

## 開発コマンド

リポジトリルートで、既存の mise 設定、Node.js と pnpm を使います。

```sh
pnpm install --frozen-lockfile
pnpm docs:generate
pnpm docs:dev
pnpm docs:check
pnpm docs:build
pnpm typecheck
pnpm test
```

`docs:dev` は Astro を背景で起動します。停止は `pnpm --filter @flow/docs astro dev stop`。ビルド結果の HTML と内部リンクは `docs:build` で検証します。`docs:check` は生成処理と同じ入力から結果を組み立てて、チェック済みの生成ファイルと照合します。

手書きページは `apps/docs/src/content/docs/`、ナビゲーションは `apps/docs/astro.config.mjs` にあります。同梱の `docs/` は CLI 配布物の仕様書とガイドで、サイトと別に収録されています。利用者向けの仕様変更では両方と README を確認します。

## 変更ごとの更新

| 変更                                  | 更新する場所                                                                                                                                                                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| コマンド・引数・オプション            | Commander を変更し、`scripts/docs/cli-notes.mjs` にコマンドパス、引数名、長いフラグ名で対応する説明を追加・修正します。使用例、結果、副作用、関連コマンドも確認します。                                                                                                    |
| 設定スキーマ                          | `src/core/types.ts`、`src/core/workflow.ts`、`tools/lib/wt.sh` とテンプレートを確認します。型と検証規則は生成されます。運用上の契約は [WORKFLOW.md](/reference/workflow/) と [worktree 設定](/reference/worktree/) で補います。                                            |
| Step、Gate、Stage                     | `templates/WORKFLOW.md` を実際のパーサーで読み、起動条件と Gate を図へ展開します。設定外の副作用による Stage 遷移は `apps/docs/src/diagrams/workflow.ts` で明示します。状態名・遷移の意味が変われば `state-machine.ts` も変更します。                                      |
| Herdr・GitHub・worktree・エージェント | `src/adapters/` と `tools/` を参照し、`architecture.ts`、`concurrency.ts`、`lifecycle.ts` の説明と接続を更新します。                                                                                                                                                       |
| CLI の表示・シナリオ                  | `scripts/docs/terminal.mjs` の状態データと実際の `runFrame()`、`Output`、選択された Commander アクションの出力からスナップショットを生成します。画面操作は `components/terminal/TerminalDemo.astro` にあります。新しい ANSI 属性に合わせて `ansi.ts` と CSS も確認します。 |

生成を実行し、`apps/docs/src/generated/` と自動生成リファレンスの差分を確認します。新規オプション・引数の解説が無いと、CLI の項目名を示して検証が失敗します。標準の `--help` は全コマンドで共有の解説を使います。

ELK は生成時にノード配置と直交経路を計算します。システム構成図は workspace の境界と配線の位置を `components/diagrams/layout/architecture.ts` で指定し、生成時にグループの包含と経路を検証します。ブラウザでは React Flow が描画・操作を担当します。図を更新したらライト・ダーク、狭い画面、キーボード操作、ノード詳細、全体表示を確認します。図の配色と余白は README の画像をもとに `components/diagrams/styles/diagram.css` で管理しています。

ブランドの SVG は製品の識別に使用しています。GitHub と GitHub Copilot の SVG は公式アーカイブから選び、Copilot は GitHub の名前も含むロックアップを使用しています。Claude は公式サンプルのマーク、Codex は公式ドキュメントのターミナルアイコンです。 [GitHub](https://brand.github.com/foundations/logo) · [Copilot](https://brand.github.com/brand-identity/copilot) · [Claude](https://platform.claude.com/docs/en/manage-claude/oauth-apps/branding-samples) · [OpenAI](https://openai.com/brand/)

## PR とリリース

PR の Documentation ワークフローは生成差分、説明の網羅性、図の参照、端末スナップショット、Astro ビルド、内部リンクと CLI テストを検証します。意味の確認が必要な変更箇所はジョブサマリーに表示します。

サイトは **main の開発版**を説明し、インストール手順に公開済み Release の例を載せます。リリース準備では以下を確認します。

1. `package.json` のバージョンを更新し、`pnpm docs:generate`。公開済みのインストール例は公開の成立を確認したタイミングで更新します。
2. 旧版から変わる CLI、設定、非推奨の機能と移行手順を明記します。表示変更があれば端末スナップショットとデモを確認します。
3. `pnpm docs:check`、`pnpm docs:build` と CLI のテストを実行します。Release ワークフローはタグがパッケージのバージョンと一致することを確認し、アーカイブと同梱テンプレートを検証します。
4. [GitHub Releases](https://github.com/fox-taiga-nakano/flow/releases) に生成されるリリースノートを確認し、互換性に影響する変更と移行方法を追記します。
