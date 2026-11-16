---
# このファイルは構成例です。REPLACE を含む値と未設定コマンドを変更するまで実行しないでください。
version: 1
timezone: Asia/Tokyo
tracker:
  kind: github
  query: { assignee: "@me", state: open }
  exclude_labels: []
stage_store:
  kind: dirs
  initial: 未着手
  rejected: 対象外
  # get を指定しない場合、Issue ディレクトリ名の第1キャプチャを段階として使います。
  pattern: '^\d+-(.+)_\d+$'
  commands:
    # flow 同梱の flow issue を使います。Issue のディレクトリは環境変数 ISSUE_DIR（メインのチェックアウトからの相対パス）の下です。
    # 段階の並び（ディレクトリ名の番号）は環境変数 ISSUE_STATUSES（空白区切り）で変えられます。
    # dir は tick ごとに何度も呼ぶので、Node を起動しない形でも書けます: 'usage_number={issue} "$FLOW_TOOLS/issue/dir"'
    dir: "flow issue dir {issue}"
    ensure: "flow issue dir --create {issue}"
    set: "flow issue mark {issue} {stage}"
workspace:
  kind: herdr
  commands:
    # flow 同梱の flow wt を使います。設定はメインのチェックアウトの .herdr/worktree.json です。
    # 現在の設定検証では workspace: none でもこれらの項目が必要です。
    list: "flow wt list"
    create_for_branch: "flow wt create {branch}"
    create_from_base: "herdr worktree create --cwd {main} --branch {branch} --base {base} --no-focus"
    assign_slot: "flow wt ports {path} --slot {slot}"
    sync: "flow wt sync {path}"
    remove: "flow wt remove {workspace}"
runner:
  kind: herdr
  close_on_complete: true
notifier:
  kind: command
  command: "herdr notification show {title} --body {body} --sound {sound}"
concurrency:
  global: 1
  per_step: { review: 1 }
locks:
  slots: []
  resources: {}
retry:
  max_attempts: 3
  backoff_ms: [60000, 120000, 240000]
stall_ms: 1200000
gates:
  base_changed: manual
  start: manual
  verify_start: auto
  finish_start: auto
  cleanup: auto
base:
  # base 名を1行目に出力する、プロジェクトの読み取りコマンドに置き換えてください。
  resolve: "printf '%s\\n' '未設定: base.resolve' >&2; exit 1"
vars:
  main: /REPLACE_WITH_ABSOLUTE_PROJECT_PATH
  owner: REPLACE_WITH_GITHUB_OWNER
  repo: REPLACE_WITH_GITHUB_REPOSITORY
steps:
  review:
    when_stage: 未着手
    gate_before: start
    workspace: none
    agent: { kind: claude, name: "flow-review-{issue}" }
    done_when: { files: [review.md] }
    on_ok: { set_stage: 完了 }
    on_ng: { stop: true, notify: action }
---

## prompt: review

Issue #{issue.number} {issue.title} を確認し、Issue ディレクトリ `{issue_dir}` の `review.md` に結果を保存してください。

完了したら `{flow_dir}/result-review-{attempt}.json` に、`result`（`ok`、`ng`、`blocked`、`failed`）、`summary`、`artifacts` の配列を書いてください。質問がある場合は `result: blocked` とし、`needs` に質問を書いてください。

作業の具体的な手順、権限、成果物、必要なスキルはプロジェクトに合わせて書き換えてください。`flow/state.json` は変更しないでください。
