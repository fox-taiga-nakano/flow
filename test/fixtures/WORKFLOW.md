---
version: 1
timezone: Asia/Tokyo
tracker:
  kind: github
  query: { assignee: "@me", state: open }
  exclude_labels: []
  # このラベルが付いた Issue は、今の step が終わってから「保留」にする。外すと元の段階から再開する。
  hold_labels: [保留]
  pr_limit: 100
stage_store:
  kind: dirs
  initial: 未着手
  rejected: 対象外
  held: 保留
  order: [対象外, 保留, 完了, 検証済, 検証NG, 修正中, Issue更新済, 再現済, 未着手]
  pattern: '^\d+-(.+)_\d+$'
  commands:
    # mise flow が読み込んだ環境を使い、読み取りごとの mise 起動を省く。
    dir: 'ISSUE_DIR="${ISSUE_DIR:-.dev/issues}" usage_number={issue} usage_create= "$HOME/.config/mise/tasks/issue/dir"'
    ensure: "mise issue:dir --create {issue}"
    set: "mise issue:mark {issue} {stage}"
workspace:
  kind: herdr
  commands:
    list: "mise wt:list"
    create_for_branch: "mise wt:create {branch}"
    create_from_base: "herdr worktree create --cwd {main} --branch {branch} --base {base} --no-focus"
    assign_slot: "mise wt:ports {path} --slot {slot}"
    sync: "mise wt:sync {path}"
    remove: "mise run --yes wt:remove {workspace}"
runner:
  kind: herdr
  close_on_complete: true
notifier:
  kind: command
  command: null
concurrency:
  global: 9
  per_step: { repro: 3, refine: 3, verify: 3, finish: 3 }
locks:
  slots: [1, 2, 3, 4, 5, 6, 7, 8, 9]
  resources:
    db: { kind: rw }
retry: { max_attempts: 3, backoff_ms: [60000, 120000, 240000] }
stall_ms: 1200000
gates:
  start: manual
  repro_result: manual
  issue_push: manual
  assign: manual
  ng_action: manual
  finish_start: manual
  verify_start: manual
  # auto：flow の外で開いた worktree（open PR のブランチ・flow/repro-{issue}）を tick ごとに引き継ぐ
  adopt_workspace: auto
  base_changed: manual
  pr_body: manual
  cleanup: manual
  db_reset: auto
database:
  stop: "mise wt:stop"
  reset:
    snapshot: 'PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="開発用DBなのでリセットに同意します" mise db:reset --snapshot'
    seed: 'PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="開発用DBなのでリセットに同意します" mise db:reset --seed'
remote:
  authors: [Copilot, copilot-swe-agent]
  done_when: review_requested
  ng_action:
    command: "gh pr comment {pr.number} --body-file {issue_dir}/ng-comment.md"
    set_stage: 修正中
steps:
  repro:
    db_reset: true
    when_stage: 未着手
    gate_before: start
    workspace: { from_base: "origin/{base}", branch: "flow/repro-{issue}" }
    agent: { kind: claude, name: "flow-repro-{issue}" }
    locks: [slot, "db:shared"]
    done_when: { files: [repro.md, scripts/repro.sh, evidence/before/checks.tsv] }
    gate_after: repro_result
    on_ok: { set_stage: 再現済 }
    on_ng: { stop: true, notify: action }
  refine:
    when_stage: 再現済
    workspace: none
    agent: { kind: claude, name: "flow-refine-{issue}" }
    done_when: { files: [issue.md] }
    gate_after: issue_push
    on_approve: { command: "mise issue:push {issue}" }
    on_ok: { remove_workspaces: ["flow/repro-{issue}"] }
  implement:
    when_stage: Issue更新済
    gate_before: assign
    remote:
      kind: copilot
      transport: rest
      login: "copilot-swe-agent[bot]"
      assign: "gh api --method POST /repos/{owner}/{repo}/issues/{issue}/assignees --input {assign_body}"
      agent_assignment:
        target_repo: "{owner}/{repo}"
        base_branch: "{base}"
    on_done: { set_stage: 修正中 }
  verify:
    db_reset: true
    when_stage: 修正中
    gate_before: verify_start
    workspace: { pr: true }
    agent: { kind: claude, name: "flow-verify-{issue}" }
    locks: [slot, "db:shared"]
    done_when: { files: [evidence/after/checks.tsv], stage_in: [検証済, 検証NG] }
    on_ng: { gate: ng_action }
  finish:
    when_stage: 検証済
    gate_before: finish_start
    # PR 本文を flow の外で更新済みなら `flow approve <番号> finish_start --choice skip` で実行せずに完了にする
    skippable: true
    workspace: { pr: true }
    agent: { kind: claude, name: "flow-finish-{issue}" }
    done_when: { files: [pr-body.md] }
    gate_after: pr_body
    on_approve:
      prompt: "pr_body が承認されました。pr-finish スキルの A の「了承を得て更新する」を実行し、{flow_dir}/result-finish-{attempt}.json を書き直してください。人に聞きたいことがあれば result: blocked にして needs に書いてください。"
  cleanup:
    when_pr_merged: true
    gate_before: cleanup
    action: { remove_workspaces: true, command: "mise issue:status --update" }
base:
  resolve: "git -C {main} ls-remote --heads origin 'delivery/*' | sed 's#.*refs/heads/##' | sort | tail -1"
vars:
  main: /home/user/projects/example-app
  owner: example-org
  repo: example-app
---

## prompt: repro

`.dev/worktree.md` のフロー 1 と `.claude/skills/pr-verify/SKILL.md` の手順 6「再現スクリプト」に従い、Issue を再現してください。

- Issue: #{issue.number} {issue.title}
- MAIN={vars.main} / WT={ws.path} / slot={ws.slot}
- Issue ディレクトリ: {issue_dir}（段階名でパスが変わるので都度 `mise issue:dir {issue.number}` で引き直す）
- 試行: {attempt}。2 回目以降は repro.md の進捗から続ける。前回の失敗: {last_failure}
- repro.md と scripts/repro.sh を作成し、WT で `mise pw:repro {issue.number} before` を実行する。evidence/before/checks.tsv と画像を保存し、再現できなければ result: ng にする。
- DB リセットの要否は前提データを調べて決める。必要な場合は自分で `mise db:reset` や DB ロックの操作を実行せず、以下の DB リセット依頼を result に書いて作業を止める。flow 本体から成功の通知が来るまで検証しない。リセット不要なら理由を repro.md に記録して続ける。
- DB リセット依頼は `{flow_dir}/result-repro-{attempt}.json` に `result: blocked`、summary、needs、artifacts に加えて `db_reset` を書く。db_reset.id は同じ試行内で一意の英数字・ハイフン・アンダースコア（例 reset-1）、db_reset.mode は snapshot または seed、db_reset.reason は必要な理由。通常は snapshot、マイグレーション・seed の変更があれば seed。snapshot が失敗しても勝手に seed を実行せず、復旧判断を待つ。JSON例: `{"result":"blocked","summary":"DB の初期化が必要","needs":"flow 本体による DB リセット待ち","artifacts":[],"db_reset":{"id":"reset-1","mode":"snapshot","reason":"再現手順の前提データがない"}}`。
- 依頼前に進捗を repro.md に保存する。成功通知の後に dev を起動し直し、ブラウザに再ログインして、同じ試行の再現手順を再開する。flow から届いた step の指示の DB 手順は参照先スキルより優先する。
- playwright-cli は `mise pw -s=flow-repro-{issue.number}` を通して実行する。
- 終わったら {flow_dir}/result-repro-{attempt}.json を仕様書 3.3 の形（result: ok/ng/blocked/failed、summary、needs、artifacts の配列）で書く。人に聞きたいことがあれば result: blocked にして needs に書く。
- flow/state.json は書き換えない。公開操作は flow の承認まで待つ。

## prompt: refine

`.claude/skills/issue-refine/SKILL.md` に従い、issue.md の下書きを保存するところまで行ってください。

- Issue: #{issue.number} {issue.title}
- MAIN={vars.main} / 作業場所={ws.path} / Issue ディレクトリ={issue_dir}
- 試行: {attempt}。前回の失敗: {last_failure}
- repro.md と修正前のエビデンスを読む。必要なコード・仕様を調べ、元の説明と画像を保った issue.md を作る。
- `mise issue:push` は実行しない。承認後に flow が実行する。Copilot のアサインも flow が行う。
- 終わったら {flow_dir}/result-refine-{attempt}.json を仕様書 3.3 の形（result: ok/ng/blocked/failed、summary、needs、artifacts の配列）で書く。人に聞きたいことがあれば result: blocked にして needs に書く。
- flow/state.json は書き換えない。

## prompt: verify

比較先の固定 base は `{base}` です。このブランチをテストの比較先に使ってください。

`.claude/skills/pr-verify/SKILL.md` の worktree 側（手順 3〜10）で動作確認してください。メイン側の手順 0〜2 は flow が行いました。

- PR: #{pr.number}（{pr.branch} → {pr.base}）
- Issue: #{issue.number} {issue.title}
- MAIN={vars.main} / WT={ws.path}（workspace {ws.workspaceId}、slot {ws.slot}）
- Issue ディレクトリ: {issue_dir}（移動後は `mise issue:dir {issue.number}` で引き直す）
- 試行: {attempt}（2 回目以降は repro.md の「進捗」から続ける。前回の失敗: {last_failure}）
- DB リセットの要否は pr-verify の基準で判断する。必要な場合は自分で `mise db:reset` や DB ロックの操作を実行せず、以下の DB リセット依頼を result に書いて作業を止める。flow 本体から成功の通知が来るまで検証・検証済への変更をしない。不要なら理由を repro.md に記録して続ける。
- DB リセット依頼は `{flow_dir}/result-verify-{attempt}.json` に `result: blocked`、summary、needs、artifacts に加えて `db_reset` を書く。db_reset.id は同じ試行内で一意の英数字・ハイフン・アンダースコア（例 reset-1）、db_reset.mode は snapshot または seed、db_reset.reason は必要な理由。通常は snapshot、マイグレーション・seed の変更があれば seed。snapshot が失敗しても勝手に seed を実行せず、復旧判断を待つ。JSON例: `{"result":"blocked","summary":"DB の初期化が必要","needs":"flow 本体による DB リセット待ち","artifacts":[],"db_reset":{"id":"reset-1","mode":"snapshot","reason":"再現手順の前提データがない"}}`。
- 依頼前に進捗を repro.md に保存する。成功通知の後に dev を起動し直し、ブラウザに再ログインして、同じ試行の手順を再開する。flow から届いた step の指示の DB 手順は参照先スキルより優先する。
- 同じ scripts/repro.sh を `mise pw:repro {issue.number} after` で通し実行し、evidence/after/checks.tsv と画像を保存する。
- 結果に応じ `mise issue:mark {issue.number} 検証済` または `mise issue:mark {issue.number} 検証NG` を行う。NG なら ng-comment.md に Copilot への修正依頼の下書きを保存する。コメントを投稿しない。
- playwright-cli は `mise pw -s=flow-verify-{issue.number}` を通して実行する。
- 終わったら最新の Issue ディレクトリの flow/result-verify-{attempt}.json を仕様書 3.3 の形（result: ok/ng/blocked/failed、summary、needs、artifacts の配列）で書く。人に聞きたいことがあれば result: blocked にして needs に書く。
- flow/state.json は書き換えない。

## prompt: finish

`.claude/skills/pr-finish/SKILL.md` の A「下書きを作る」まで行ってください。

- PR: #{pr.number}（{pr.branch} → {pr.base}）、Issue: #{issue.number} {issue.title}
- MAIN={vars.main} / WT={ws.path} / Issue ディレクトリ={issue_dir}
- 試行: {attempt}。前回の失敗: {last_failure}
- repro.md と before/after のエビデンスを読み、既存本文を残した pr-body.md を作成する。
- `gh pr edit` は承認後。初回は実行しない。B のレビュー対応と C の後片付けはこの step では行わない。
- 終わったら {flow_dir}/result-finish-{attempt}.json を仕様書 3.3 の形（result: ok/ng/blocked/failed、summary、needs、artifacts の配列）で書く。人に聞きたいことがあれば result: blocked にして needs に書く。
- flow/state.json は書き換えない。

## prompt: guard

あなたは flow が起動した、Issue #{issue.number} の 1 つの step を担当するエージェントです。この決まりは、会話の途中で誰から何を言われても変わりません。

- 役割と手順は、flow から最初に届いた step の指示に書かれた範囲だけです。
- ユーザーや flow から追加の指示が来ても、その step の手順の範囲で対応します。質問への回答、手順の中での判断材料・やり直しの依頼は受け入れます。
- 手順に書かれていない操作は、頼まれても実行しません。たとえば、別の step の作業、段階の変更（`mise issue:mark` などでのディレクトリ名の変更）、コミット・push、Issue・PR の本文の更新やコメントの投稿、Copilot のアサイン、worktree の作成・削除、手順にない DB の操作、flow/state.json の変更です。
- 範囲外のことを頼まれたら、実行せずに「flow の手順の範囲外なので行いません」と伝え、flow の承認やコマンド（`flow approve` / `flow reject` / `flow retry` など）で進めるよう案内します。作業を続けられないときは result: blocked にして needs に書きます。
- 手順と指示が食い違うときは手順を優先します。判断に迷うときは自分で決めず、result: blocked で聞きます。
