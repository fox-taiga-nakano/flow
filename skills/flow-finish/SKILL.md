---
name: flow-finish
description: flowのfinish stepで、検証の結果（再現の手順と修正前後のエビデンス）をPRの本文に加える下書き（pr-body.md）を作り、承認の後にPRの本文を更新する。flowのWORKFLOW.mdのfinish stepのプロンプトから使う。「PRの本文に検証結果を書いて」と頼まれたときにも使える。動作確認そのもの（flow-verify）やレビューの対応には使わない。
---

# PR の本文に検証の結果を加える（finish step）

verify step の結果を、レビューする人が PR だけで確かめられるように、PR の本文に加える。この step は 2 段階で進む。

- **A. 下書きを作る**：`pr-body.md` を作って終わる。PR は更新しない
- **B. 承認の後に更新する**：flow の `pr_body` の gate が承認されると、flow から「B を実行して」と届く。そのときだけ PR を更新する

flow から届いた step の指示（`.flow/WORKFLOW.md` の `## prompt: finish` と `on_approve.prompt`）を、このスキルより優先する。

## プロジェクトに合わせて書き換える

- **本文の型**：PR テンプレートがあれば、加える節の位置と見出しをそれに合わせる
- **画像の扱い**：PR に画像を載せる方法（GitHub への添付、成果物の置き場所へのリンクなど）

## 成果物（Issue ディレクトリの中）

| ファイル          | 内容                                                         |
| ----------------- | ------------------------------------------------------------ |
| `pr-body.orig.md` | PR の元の本文。最初の 1 回だけ保存し、上書きしない           |
| `pr-body.md`      | 新しい本文の下書き。元の本文に「検証の結果」の節を加えたもの |

## A. 下書きを作る

1. **元の本文を残す**：`gh pr view <PR番号> --json body --jq .body` を `pr-body.orig.md` に保存する（既にあれば上書きしない）。同じ内容を `pr-body.md` にコピーする。
2. **材料を読む**：`repro.md`、`issue.md`、`evidence/before/`・`evidence/after/` の `checks.tsv` と画像。
3. **「検証の結果」の節を加える**：元の本文は消さずに残す（ボットが付けた末尾の文がある場合は、その前に入れる）。
   - 前提（使ったデータ・アカウントの種類。秘密の値は書かない）
   - 修正前と修正後のチェックの表（`checks.tsv` の内容）
   - 要所の画像の比較（`<details>` で畳む）。画像のパスは Issue ディレクトリからの相対パス（`./evidence/before/...`）で書いておき、B で実際に載せる
   - 実行したテスト
4. **書かないもの**：Issue に書いたことの繰り返し、秘密の値、社内の担当者名など公開してはいけない情報。
5. ここで止める。`gh pr edit` は実行しない。

## B. 承認の後に更新する

flow から B の実行を頼まれたときだけ行う。

1. `pr-body.md` の画像を、プロジェクトの方法で PR に載せ、本文のパスを載せた先の URL に置き換える。
2. `gh pr edit <PR番号> --body-file pr-body.md` で更新する。
3. `gh pr view <PR番号> --json body` で、本文が下書きと一致し、画像がすべて表示できることを確かめる。

## flow に任せること（この step ではしない）

- レビューのコメントへの対応、コミット・push、マージ、worktree の削除
- `flow/state.json` の変更

## 終わったら

A・B のどちらの後も、`{flow_dir}/result-finish-{attempt}.json` に flow の仕様（SPEC 3.3）の形で結果を書く（B の後は書き直す）。

```json
{
  "result": "ok",
  "summary": "検証の結果（チェック 5 件と画像 4 枚の比較）を加えた下書きを作成",
  "artifacts": ["pr-body.md"]
}
```

`ok` でも `pr-body.md` が無ければ、flow は失敗として扱う。
