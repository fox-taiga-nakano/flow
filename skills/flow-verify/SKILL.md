---
name: flow-verify
description: flowのverify stepで、PRのブランチのworktreeでrepro stepと同じ再現スクリプトを実行し、修正後のエビデンス（evidence/after/）を残して、検証済か検証NGかを決める。flowのWORKFLOW.mdのverify stepのプロンプトから使う。「PRを動作確認して」「修正を検証して」と頼まれたときにも使える。Issueの再現（flow-repro）やPR本文の更新（flow-finish）には使わない。
---

# PR の動作確認（verify step）

repro step で作った `scripts/repro.sh` を、PR のブランチ（修正後のコード）で実行し、修正前と比べる。チェックがすべて OK で、修正の影響でほかが壊れていなければ「検証済」、そうでなければ「検証NG」にする。

flow から届いた step の指示（`.flow/WORKFLOW.md` の `## prompt: verify`）を、このスキルより優先する。

## プロジェクトに合わせて書き換える

- **開発サーバーの起動・画面の操作・データの準備**：`flow-repro` スキルの同じ節と合わせる。ブラウザのセッション名は `flow-verify-<Issue番号>`
- **テストと型チェック**：変更した範囲で実行するコマンド（例：`pnpm test <パス>`、`pnpm typecheck`）

## 成果物（Issue ディレクトリの中）

| ファイル                    | 内容                                                                           |
| --------------------------- | ------------------------------------------------------------------------------ |
| `evidence/after/checks.tsv` | `scripts/repro.sh after` のチェックの結果（書式は repro と同じ）               |
| `evidence/after/*.png` など | 修正後のスクリーンショット。修正前と同じ名前にして、並べて比べられるようにする |
| `repro.md`                  | 「進捗」と、修正後の結果・比較・テストの結果を追記する                         |
| `ng-comment.md`             | 検証NG のときだけ。実装者への修正依頼の下書き（投稿しない）                    |

Issue ディレクトリは、段階を変えるとパスが変わる。使う前に `flow issue dir <Issue番号>` で引き直す。

## 手順

1. **前提を読む**：`repro.md`、`issue.md`、`scripts/repro.sh`、`evidence/before/` を読む。2 回目以降の試行では、`repro.md` の「進捗」から続ける。
2. **環境を用意する**：worktree（PR のブランチ）で依存関係を入れ、開発サーバーを起動する。repro と同じ前提データにする。
3. **再現スクリプトを実行する**：`scripts/repro.sh after` を実行する。スクリプトは書き換えない（比べられなくなるため）。動かない場合は、PR の変更で画面の構造が変わったなどの理由を確かめ、直したときは repro.md に理由を書く。
4. **比べる**：`evidence/before/` と `evidence/after/` のチェックと画像を並べて確かめる。画像は開いて確かめる。スクリプトで確かめられない点だけを手で確かめる。
5. **影響を確かめる**：変更した範囲のテストと型チェックを実行する。`issue.md` の「実装の条件」（守る既存の動作、同じ処理を使う箇所）を確かめる。
6. **記録する**：`repro.md` に、修正後の結果の表、修正前と修正後の画像の対応、テストの結果を書く。
7. **段階を決める**：
   - すべて OK：`flow issue mark <Issue番号> 検証済`
   - NG があれば：`flow issue mark <Issue番号> 検証NG`。`ng-comment.md` に、何が・どの手順で・どう違うか（期待と実際、エビデンスのパス）を、実装者が直せる形で書く。コメントは投稿しない（flow が承認の後に投稿する）

## flow に任せること（この step ではしない）

- PR へのコメントの投稿、コミット・push、PR の本文の更新、worktree の作成・削除
- `flow/state.json` の変更

## 終わったら

段階を変えたので、`flow issue dir <Issue番号>` で引き直した Issue ディレクトリの `flow/result-verify-{attempt}.json` に、flow の仕様（SPEC 3.3）の形で結果を書く。

```json
{
  "result": "ok",
  "summary": "repro.sh after のチェック 5 件がすべて OK、関連テストも成功",
  "artifacts": ["evidence/after/checks.tsv", "repro.md"]
}
```

- 検証NG にした場合は `result: ng` にし、`artifacts` に `ng-comment.md` を含める
- `evidence/after/checks.tsv` が無いか、段階が「検証済」「検証NG」のどちらでもなければ、flow は失敗として扱う
