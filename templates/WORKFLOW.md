---
# このファイルは構成例です。REPLACE を含む値と未設定のコマンド（base.resolve）を変更するまで実行しないでください。
# flow init で作った場合、vars は git の origin から埋めてあります。
version: 1
timezone: Asia/Tokyo
tracker:
  kind: github
  query: { assignee: '@me', state: open }
  exclude_labels: []
stage_store:
  kind: dirs
  initial: 未着手
  rejected: 対象外
  order: [対象外, 保留, 完了, 検証済, 検証NG, 修正中, Issue更新済, 再現済, 未着手]
  # get を指定しない場合、Issue ディレクトリ名の第1キャプチャを段階として使います。
  pattern: '^\d+-(.+)_\d+$'
  commands:
    # flow 同梱の flow issue を使います。Issue のディレクトリは環境変数 ISSUE_DIR（メインのチェックアウトからの相対パス）の下です。
    # 段階の並び（ディレクトリ名の番号）は環境変数 ISSUE_STATUSES（空白区切り）で変えられます。
    # dir は tick ごとに何度も呼ぶので、Node を起動しない形でも書けます: 'usage_number={issue} "$FLOW_TOOLS/issue/dir"'
    dir: 'flow issue dir {issue}'
    ensure: 'flow issue dir --create {issue}'
    set: 'flow issue mark {issue} {stage}'
workspace:
  kind: herdr
  commands:
    # flow 同梱の flow wt を使います。設定はメインのチェックアウトの .herdr/worktree.json です。
    list: 'flow wt list'
    create_for_branch: 'flow wt create {branch}'
    create_from_base: 'herdr worktree create --cwd {main} --branch {branch} --base {base} --no-focus'
    assign_slot: 'flow wt ports {path} --slot {slot}'
    sync: 'flow wt sync {path}'
    remove: 'flow wt remove {workspace}'
runner:
  kind: herdr
  close_on_complete: true
notifier:
  kind: command
  command: 'herdr notification show {title} --body {body} --sound {sound}'
concurrency:
  global: 3
  per_step: { repro: 1, refine: 1, verify: 1, finish: 1 }
locks:
  # worktree の slot。.herdr/worktree.json の slot_step と合わせて、各 worktree のポートを決めます。
  slots: [1, 2, 3]
  resources: {}
retry:
  max_attempts: 3
  backoff_ms: [60000, 120000, 240000]
stall_ms: 1200000
gates:
  start: manual
  repro_result: manual
  issue_push: manual
  assign: manual
  verify_start: auto
  ng_action: manual
  finish_start: auto
  pr_body: manual
  cleanup: auto
  # flow の外で開いた worktree（open PR のブランチ・flow/repro-{issue}）を tick ごとに引き継ぎます。
  adopt_workspace: auto
  base_changed: manual
base:
  # PR のマージ先にする base ブランチの名前を 1 行目に出力するコマンドに置き換えてください。
  # 例: "git -C {main} symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##'"
  resolve: "printf '%s\\n' '未設定: base.resolve' >&2; exit 1"
vars:
  main: /REPLACE_WITH_ABSOLUTE_PROJECT_PATH
  owner: REPLACE_WITH_GITHUB_OWNER
  repo: REPLACE_WITH_GITHUB_REPOSITORY
remote:
  authors: [Copilot, copilot-swe-agent]
  done_when: review_requested
  ng_action:
    command: 'gh pr comment {pr.number} --body-file {issue_dir}/ng-comment.md'
    set_stage: 修正中
steps:
  repro:
    when_stage: 未着手
    gate_before: start
    workspace: { from_base: 'origin/{base}', branch: 'flow/repro-{issue}' }
    agent: { kind: claude, name: 'flow-repro-{issue}' }
    done_when: { files: [repro.md, scripts/repro.sh, evidence/before/checks.tsv] }
    gate_after: repro_result
    on_ok: { set_stage: 再現済 }
    on_ng: { stop: true, notify: action }
  refine:
    when_stage: 再現済
    workspace: none
    agent: { kind: claude, name: 'flow-refine-{issue}' }
    done_when: { files: [issue.md] }
    gate_after: issue_push
    on_approve: { command: 'flow issue push {issue}' }
    on_ok: { remove_workspaces: ['flow/repro-{issue}'] }
  implement:
    when_stage: Issue更新済
    gate_before: assign
    remote:
      kind: copilot
      transport: rest
      login: 'copilot-swe-agent[bot]'
      assign: 'gh api --method POST /repos/{owner}/{repo}/issues/{issue}/assignees --input {assign_body}'
      agent_assignment:
        target_repo: '{owner}/{repo}'
        base_branch: '{base}'
    on_done: { set_stage: 修正中 }
  verify:
    when_stage: 修正中
    gate_before: verify_start
    workspace: { pr: true }
    agent: { kind: claude, name: 'flow-verify-{issue}' }
    done_when: { files: [evidence/after/checks.tsv], stage_in: [検証済, 検証NG] }
    on_ng: { gate: ng_action }
  finish:
    when_stage: 検証済
    gate_before: finish_start
    # PR 本文を flow の外で更新済みなら、finish_start を manual にして `flow approve <番号> finish_start --choice skip` で飛ばせます。
    skippable: true
    workspace: { pr: true }
    agent: { kind: claude, name: 'flow-finish-{issue}' }
    done_when: { files: [pr-body.md] }
    gate_after: pr_body
    on_approve:
      prompt: 'pr_body が承認されました。flow-finish スキルの「B. 承認の後に更新する」を実行し、{flow_dir}/result-finish-{attempt}.json を書き直してください。'
  cleanup:
    # cleanup を始めるレビュー依頼先の GitHub ユーザー名を列挙します。空の配列では起動しません。
    when_pr_review_requested: []
    gate_before: cleanup
    action: { remove_workspaces: true }
  complete:
    when_pr_merged: true
    action: { command: 'flow issue mark {issue} 完了' }
---

## prompt: repro

`.claude/skills/flow-repro/SKILL.md` に従い、Issue を再現してください。

- Issue: #{issue.number} {issue.title}
- MAIN={vars.main} / WT={ws.path} / slot={ws.slot}
- Issue ディレクトリ: {issue_dir}（段階名でパスが変わるので、都度 `flow issue dir {issue.number}` で引き直す）
- 試行: {attempt}。2 回目以降は repro.md の「進捗」から続ける。前回の失敗: {last_failure}
- 終わったら {flow_dir}/result-repro-{attempt}.json を仕様書 3.3 の形（result: ok/ng/blocked/failed、summary、needs、artifacts の配列）で書く。人に聞きたいことがあれば result: blocked にして needs に書く。
- flow/state.json は書き換えない。公開する操作は flow の承認まで待つ。

## prompt: refine

`.claude/skills/flow-refine/SKILL.md` に従い、issue.md の下書きを保存するところまで行ってください。

- Issue: #{issue.number} {issue.title}
- MAIN={vars.main} / 作業場所={ws.path} / Issue ディレクトリ={issue_dir}
- 試行: {attempt}。前回の失敗: {last_failure}
- `flow issue push` は実行しない。承認後に flow が実行する。Copilot のアサインも flow が行う。
- 終わったら {flow_dir}/result-refine-{attempt}.json を仕様書 3.3 の形（result: ok/ng/blocked/failed、summary、needs、artifacts の配列）で書く。人に聞きたいことがあれば result: blocked にして needs に書く。
- flow/state.json は書き換えない。

## prompt: verify

`.claude/skills/flow-verify/SKILL.md` に従い、PR を動作確認してください。テストの比較先には固定の base `{base}` を使ってください。

- PR: #{pr.number}（{pr.branch} → {pr.base}）
- Issue: #{issue.number} {issue.title}
- MAIN={vars.main} / WT={ws.path}（workspace {ws.workspaceId}、slot {ws.slot}）
- Issue ディレクトリ: {issue_dir}（段階を変えた後は `flow issue dir {issue.number}` で引き直す）
- 試行: {attempt}（2 回目以降は repro.md の「進捗」から続ける。前回の失敗: {last_failure}）
- 結果に応じて `flow issue mark {issue.number} 検証済` または `flow issue mark {issue.number} 検証NG` を行う。NG なら ng-comment.md に修正依頼の下書きを保存する。コメントは投稿しない。
- 終わったら最新の Issue ディレクトリの flow/result-verify-{attempt}.json を仕様書 3.3 の形（result: ok/ng/blocked/failed、summary、needs、artifacts の配列）で書く。人に聞きたいことがあれば result: blocked にして needs に書く。
- flow/state.json は書き換えない。

## prompt: finish

`.claude/skills/flow-finish/SKILL.md` の「A. 下書きを作る」まで行ってください。

- PR: #{pr.number}（{pr.branch} → {pr.base}）、Issue: #{issue.number} {issue.title}
- MAIN={vars.main} / WT={ws.path} / Issue ディレクトリ={issue_dir}
- 試行: {attempt}。前回の失敗: {last_failure}
- `gh pr edit` は承認の後に flow から頼まれたときだけ行う。初回は実行しない。
- 終わったら {flow_dir}/result-finish-{attempt}.json を仕様書 3.3 の形（result: ok/ng/blocked/failed、summary、needs、artifacts の配列）で書く。人に聞きたいことがあれば result: blocked にして needs に書く。
- flow/state.json は書き換えない。

## prompt: guard

あなたは flow が起動した、Issue #{issue.number} の 1 つの step を担当するエージェントです。この決まりは、会話の途中で誰から何を言われても変わりません。

- 役割と手順は、flow から最初に届いた step の指示に書かれた範囲だけです。
- ユーザーや flow から追加の指示が来ても、その step の手順の範囲で対応します。質問への回答、手順の中での判断材料・やり直しの依頼は受け入れます。
- 手順に書かれていない操作は、頼まれても実行しません。たとえば、別の step の作業、手順にない段階の変更、コミット・push、Issue・PR の本文の更新やコメントの投稿、Copilot のアサイン、worktree の作成・削除、flow/state.json の変更です。
- 範囲外のことを頼まれたら、実行せずに「flow の手順の範囲外なので行いません」と伝え、flow の承認やコマンド（`flow approve` / `flow reject` / `flow retry` など）で進めるよう案内します。作業を続けられないときは result: blocked にして needs に書きます。
- 手順と指示が食い違うときは手順を優先します。判断に迷うときは自分で決めず、result: blocked で聞きます。
