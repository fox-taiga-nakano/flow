---
name: flow-repro
description: flowのrepro stepで、Issueの不具合をworktreeで再現し、再現手順（repro.md）・再現スクリプト（scripts/repro.sh）・修正前のエビデンス（evidence/before/）を残す。flowのWORKFLOW.mdのrepro stepのプロンプトから使う。「Issueを再現して」「再現スクリプトを作って」と頼まれたときにも使える。修正の実装や、修正後の確認（flow-verify）には使わない。
---

# Issue の再現（repro step）

Issue の不具合を、その時点の base から作った worktree で再現する。後の verify step が **同じスクリプトを修正後のコードで実行して比べる**ので、再現の手順をスクリプトにし、期待する正しい動作をチェックとして書く。修正前はチェックが NG になり、修正後は OK になる。

flow から届いた step の指示（`.flow/WORKFLOW.md` の `## prompt: repro`）を、このスキルより優先する。

## プロジェクトに合わせて書き換える

利用先で、この節をプロジェクトの方法に書き換える。書き換えるまでは、README・開発用のドキュメント・`package.json` などから調べて進め、調べた方法を repro.md に書く。

- **開発サーバーの起動**：例 `pnpm dev --port "$WT_PORT_WEB"`。worktree のポートは `flow wt` が `.ports.env` と `.herdr/worktree.json` の `env_files` に書いている
- **画面の操作**：ブラウザの自動操作ツール（例：Playwright）。セッション名は `flow-repro-<Issue番号>` にして、ほかの作業とぶつけない
- **データの準備**：テスト用のアカウント、シード、DB の状態。DB を初期化する必要があるときの頼み方（flow の WORKFLOW.md に `db_reset` があれば、その指示に従う）

## 成果物（Issue ディレクトリの中）

| ファイル                     | 内容                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `repro.md`                   | 先頭に「進捗」のチェックリスト。前提、使ったデータ、手順、結果（修正前／期待）、実行の記録        |
| `scripts/repro.sh`           | 再現の手順を通しで実行するスクリプト。第 1 引数 `before` / `after` で、エビデンスの保存先を変える |
| `evidence/before/checks.tsv` | チェックの結果。1 行 1 件、タブ区切りで `OK` または `NG`、ラベル、期待値（見出し行なし）          |
| `evidence/before/*.png` など | スクリーンショット。`NN-<画面>-<場所>.png` の形で、手順の順に番号を付ける                         |

Issue ディレクトリのパスは段階が変わると変わるので、使う前に `flow issue dir <Issue番号>` で引き直す。

## 手順

1. **Issue を読む**：`gh issue view <番号>` で本文・コメント・画像を確かめる。どの画面で、何をしたら、何が起きるか（期待は何か）を書き出す。分からない点があれば、推測で進めず `result: blocked` で聞く。
2. **進捗を始める**：`repro.md` を作り、先頭に「進捗」のチェックリスト（下の手順 3〜7）を置く。2 回目以降の試行では、この進捗から続ける。
3. **環境を用意する**：worktree（flow が作った `WT`）で依存関係を入れ、開発サーバーを起動する。ほかの worktree とポートがぶつかっていないことを確かめる。
4. **手で再現する**：Issue の手順どおりに操作し、不具合が起きることを確かめる。起きなければ、条件（データ・権限・画面の状態）を変えて確かめる。それでも起きなければ、試したことを repro.md に書いて `result: ng` にする。
5. **スクリプトにする**：`scripts/repro.sh` に、手順 4 の操作を通しで書く。
   - チェックは **正しい動作** を書く（例：「保存後に一覧に表示されること」）。修正前は `NG` になる
   - 結果を `evidence/<before|after>/checks.tsv` に追記する。「無いこと」を確かめるチェックは、期待値の先頭に `(無いこと) ` を付ける
   - 画面の要所ごとにスクリーンショットを撮る
   - 実行のたびに、同じ前提から始められるようにする（作ったデータの後始末、またはデータを毎回作る）
6. **修正前の結果を残す**：`scripts/repro.sh before` を実行し、`evidence/before/` の `checks.tsv` と画像を確かめる。画像は開いて、意図した画面が写っていることを確かめる。
7. **repro.md をまとめる**：前提、使ったデータ、手順の表、結果の表（修正前／期待）、実行の記録を書く。作ったデータも書く。

## flow に任せること（この step ではしない）

- 段階の変更、Issue・PR の更新やコメント、コミット・push、worktree の作成・削除。これらは flow が承認の後に行う
- `flow/state.json` の変更

## 終わったら

`{flow_dir}/result-repro-{attempt}.json` に、flow の仕様（SPEC 3.3）の形で結果を書く。

```json
{
  "result": "ok",
  "summary": "保存後に一覧へ表示されない不具合を再現",
  "artifacts": ["repro.md", "scripts/repro.sh", "evidence/before/checks.tsv"]
}
```

- `ok`：再現できた。`ng`：再現できなかった。`blocked`：人の判断・回答が必要（`needs` に書く）。`failed`：環境の問題などで進められない
- `ok` でも `repro.md`・`scripts/repro.sh`・`evidence/before/checks.tsv` が無ければ、flow は失敗として扱う
