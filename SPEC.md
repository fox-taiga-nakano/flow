# flow 仕様書

flow は、自分にアサインされた Issue を自動で取得し、「再現 → Issue 更新 → 実装（Copilot）→ 検証 → 仕上げ」の段階を、
段階ごとのエージェントに並行して進めさせるオーケストレーター。OpenAI Symphony（https://github.com/openai/symphony/blob/main/SPEC.md）の
考え方を取り入れ、複数の段階・人の承認（gate）・資源の排他（lock）を足したもの。

将来は Claude Code のプラグインにする。そのため、**汎用の部分（この仕様書の 1〜9）**と、
**プロジェクト固有の部分（`WORKFLOW.md`、段階のスキル、mise タスク）**をはっきり分ける。
汎用の部分のコードに、example-app 固有の名前（mise タスク名、画面名、`.dev/issues` のパスなど）を直接書かない。
固有の値はすべて `WORKFLOW.md` から受け取る。

## 0. 原則

1. **オーケストレーターは判断しない**。状態を読む、ロックを取る、エージェントを起動する、成果物の有無を見る、だけを行う。
   考える仕事（再現手順を書く、妥当か判断する）は段階のエージェントが行う。オーケストレーターは LLM を呼ばない
2. **唯一の正はトラッカー（GitHub）とファイル**。オーケストレーターはメモリに状態を持たない。プロセスが落ちても、次の tick で読み直せば続きから動く
3. **完了はファイルで判定する**。エージェントの返答の文言で判定しない
4. **外に公開する操作の前は gate で止める**（既定はすべて manual。`db_reset` だけ auto）。gate の承認は人が `flow approve` で行う
5. **冪等**。同じ tick を 2 回実行しても、同じ結果になる（二重に起動しない、二重に投稿しない）

## 1. 構成

```
flow（CLI / 常駐）
├─ core/
│   ├─ workflow      WORKFLOW.md の読み込み・検証（YAML front matter + 段階ごとのプロンプト）
│   ├─ state         Issue ごとの state.json の読み書き（原子的に書く：tmp に書いて rename）
│   ├─ orchestrator  tick：突き合わせ → 完了の判定 → 割り振り → 記録
│   ├─ locks         資源のロック（ファイルロック。プロセスをまたいで効く）
│   ├─ gates         承認待ちの管理、承認時の処理
│   └─ template      プロンプトのテンプレート（未定義の変数はエラーにする）
├─ adapters/         インターフェースは 2 章。実装は差し替えられる
│   ├─ tracker/github        gh CLI
│   ├─ stage-store/dirs      状態をディレクトリ名で持つ（WORKFLOW.md のコマンドを呼ぶ）
│   ├─ workspace/herdr       herdr worktree
│   ├─ runner/herdr          herdr のペインの claude / codex
│   ├─ remote/copilot        Copilot Coding Agent
│   └─ notifier/command      任意のコマンドで通知
└─ cli/              flow tick / run / status / approve / reject / lock / stop / logs
```

- TypeScript（Node 24）。外部ライブラリは最小限（YAML パーサー、テンプレートエンジン、CLI 引数）
- 外部コマンド（gh・herdr・mise）は、すべて `exec` のアダプター経由で呼ぶ（テストで差し替えるため）
- `--dry-run` では、外部コマンドのうち**状態を変えるもの**を呼ばず、呼ぶ予定のコマンドを表示する（読み取りのコマンドは呼んでよい）

## 2. アダプターのインターフェース

```ts
interface Tracker {
  listCandidates(): Promise<TrackerIssue[]>; // WORKFLOW.md の tracker.query の条件（例：自分にアサイン・open）
  getIssue(n: number): Promise<TrackerIssue | null>; // 突き合わせ用。null は見つからない
  findPullRequests(issue: number): Promise<TrackerPR[]>; // その Issue を閉じる PR（open / merged / closed）
}
type TrackerIssue = {
  number: number;
  title: string;
  state: "open" | "closed";
  assignees: string[];
  labels: string[];
  createdAt: string;
  url: string;
};
type TrackerPR = {
  number: number;
  branch: string;
  base: string;
  state: "open" | "merged" | "closed";
  isDraft: boolean;
  author: string;
  url: string;
};

interface StageStore {
  // 段階（人が見る状態）の読み書き
  get(issue: number): Promise<string | null>; // 例：'未着手'。ディレクトリが無ければ null
  set(issue: number, stage: string): Promise<void>;
  ensure(issue: number): Promise<string>; // 無ければ初期状態で作り、Issue のディレクトリの絶対パスを返す
  dir(issue: number): Promise<string>; // Issue のディレクトリの絶対パス
}

interface Workspace {
  ensure(spec: { key: string; branch: string; base?: string }): Promise<WorkspaceInfo>; // 既にあれば再利用する
  sync(ws: WorkspaceInfo): Promise<void>;
  remove(ws: WorkspaceInfo): Promise<void>;
  list(): Promise<WorkspaceInfo[]>;
}
type WorkspaceInfo = {
  key: string;
  path: string;
  workspaceId: string | null;
  branch: string;
  slot: number | null;
};

interface Runner {
  start(spec: { name: string; ws: WorkspaceInfo; kind: "claude" | "codex"; prompt: string }): Promise<AgentHandle>;
  status(h: AgentHandle): Promise<"working" | "idle" | "blocked" | "done" | "gone">;
  prompt(h: AgentHandle, text: string): Promise<void>; // 承認後の続きの指示など
  tail(h: AgentHandle, lines: number): Promise<string>; // ログ用
  stop(h: AgentHandle): Promise<void>; // 人の指示（flow stop）か、Issue が対象外になったときだけ
}
type AgentHandle = { runner: string; name: string; paneId?: string };

interface RemoteAgent {
  // 手元で動かないエージェント（Copilot など）
  request(issue: number): Promise<void>; // 例：Copilot をアサイン
  poll(issue: number): Promise<"pending" | "working" | "done" | "failed">;
}

interface Notifier {
  notify(msg: { issue: number; title: string; body: string; level: "info" | "action" | "error" }): Promise<void>;
}
```

## 3. 状態

### 3.1 段階（stage）

人が見る状態。`StageStore` が持つ（example-app ではディレクトリ名）。段階の名前と遷移は `WORKFLOW.md` で決め、コードに書かない。

### 3.2 実行の情報（state.json）

`<Issue のディレクトリ>/flow/state.json`。オーケストレーターだけが書く（エージェントは書かない）。

```json
{
  "version": 1,
  "issue": 3740,
  "step": "verify",
  "status": "running",
  "attempt": 1,
  "agent": { "runner": "herdr", "name": "flow-verify-3740", "paneId": "w1N:2" },
  "workspace": {
    "key": "pr-4050",
    "path": "/home/.../copilot-...",
    "workspaceId": "w1N",
    "branch": "copilot/...",
    "slot": 1
  },
  "locks": ["slot:1", "db:shared"],
  "gate": null,
  "nextRetryAt": null,
  "startedAt": "...",
  "updatedAt": "...",
  "lastActivityAt": "...",
  "history": [{ "step": "verify", "attempt": 0, "result": "failed", "reason": "...", "at": "..." }]
}
```

- `status`：`idle`（次の割り振り待ち）/ `running` / `waiting_gate` / `waiting_remote` / `retry_wait` / `failed`（リトライ上限）/ `stopped`（人が止めた）/ `done`
- `gate`：`{ "name": "issue_push", "since": "...", "summary": "...", "artifacts": ["issue.md"] }`
- 原子的に書く（同じディレクトリの tmp に書いて rename）。読めない・壊れているときは、その Issue を飛ばしてエラーを通知する（勝手に作り直さない）

### 3.3 エージェントの結果（result.json）

段階のエージェントは、終わるときに `<Issue のディレクトリ>/flow/result-<step>-<attempt>.json` を書く。

```json
{ "result": "ok" | "ng" | "blocked" | "failed", "summary": "1〜3 行", "needs": "人に頼みたいこと（blocked のとき）", "artifacts": ["repro.md", "..."] }
```

- オーケストレーターは、`result.json` と段階の `done_when`（4 章）の**両方**で判定する。`result.json` が `ok` でも `done_when` を満たさなければ失敗扱いにする
- エージェントが `idle` / `done` なのに `result.json` が無いときは、1 回だけ「result.json を書いてください」と `prompt` する。それでも無ければ失敗扱い

## 4. WORKFLOW.md

YAML front matter（設定）と、段階ごとのプロンプト（本文の `## prompt: <step>` 見出しの下）からなる。tick のたびに読み直す。不正なら直前の正しい設定で動き続け、エラーを通知する。

```yaml
version: 1
tracker:
  kind: github
  query: { assignee: "@me", state: open } # gh issue list に渡す条件
  exclude_labels: []
  hold_labels: [保留] # このラベルの Issue は今の step の終了後に held へ（8 章）
stage_store:
  kind: dirs
  initial: 未着手
  rejected: 対象外 # flow reject で却下した Issue の段階（8 章）
  held: 保留 # hold_labels で止めた Issue の段階。hold_labels とセットで指定する
  commands: # プロジェクト固有のコマンド。{issue} {stage} を置き換える
    dir: "mise issue:dir {issue}"
    ensure: "mise issue:dir --create {issue}"
    set: "mise issue:mark {issue} {stage}"
workspace:
  kind: herdr
  commands:
    create_for_branch: "mise wt:create {branch}" # 最終行 worktree=<path> workspace=<id> pane=<id>
    create_from_base: "herdr worktree create --cwd {main} --branch {branch} --base {base} --no-focus"
    sync: "mise wt:sync {path}"
    remove: "mise run --yes wt:remove {workspace}"
runner:
  kind: herdr # メインは Issue タブ、worktree は agent タブで起動する（10.2）
notifier:
  kind: command
  command: "herdr notification show {title} --body {body} --sound {sound}" # action・error は request、info は none
concurrency:
  global: 9
  per_step: { repro: 3, refine: 3, verify: 3, finish: 3 }
locks:
  slots: [1, 2, 3, 4, 5, 6, 7, 8, 9] # worktree ごとに 1 つ
  resources:
    db: { kind: rw } # shared（複数可）/ exclusive（1 つだけ、shared と同時に取れない）
retry: { max_attempts: 3, backoff_ms: [60000, 120000, 240000] }
stall_ms: 1200000 # この間エージェントの出力が変わらなければ止まったとみなす
gates: # manual：flow approve を待つ / auto：自動で承認
  start: manual
  repro_result: manual
  issue_push: manual
  assign: manual
  ng_action: manual
  verify_start: manual
  finish_start: manual
  adopt_workspace: manual
  base_changed: manual
  pr_body: manual
  cleanup: manual
  db_reset: auto
steps: # 段階（stage）ごとに、次に行う step を決める
  repro:
    when_stage: 未着手
    gate_before: start
    workspace: { from_base: "origin/{base}", branch: "flow/repro-{issue}" } # {base} は 9.1 で求めた今の base
    agent: { kind: claude, name: "flow-repro-{issue}" }
    locks: [slot, db:shared]
    done_when: { files: ["repro.md", "scripts/repro.sh", "evidence/before/checks.tsv"] }
    gate_after: repro_result
    on_ok: { set_stage: 再現済 }
    on_ng: { stop: true, notify: action } # 再現できなかった・仕様の確認が要る。stage は変えず stopped にして人に渡す
  refine:
    when_stage: 再現済
    workspace: none # メインのチェックアウトで動く
    agent: { kind: claude, name: "flow-refine-{issue}" }
    done_when: { files: ["issue.md"] }
    gate_after: issue_push
    on_approve: { command: "mise issue:push {issue}" } # 承認されたらオーケストレーターが実行する。stage は issue:push が Issue更新済 にする
    on_ok: { remove_workspaces: ["flow/repro-{issue}"] } # Issue 更新後に repro の worktree を削除して slot を解放する。拒否されたら通知して cleanup で再試行する
  implement:
    when_stage: Issue更新済
    gate_before: assign
    remote:
      {
        kind: copilot,
        assign: "gh api --method POST /repos/{owner}/{repo}/issues/{issue}/assignees --input {assign_body}",
      } # 9.2
    on_done: { set_stage: 修正中 } # PR が見つかり、Copilot の作業が終わったら
  verify:
    when_stage: 修正中
    gate_before: verify_start
    workspace: { pr: true } # その Issue を閉じる open な PR のブランチ
    agent: { kind: claude, name: "flow-verify-{issue}" } # 手で pr-verify を使うときの verify-<番号> と重ならない名前にする
    locks: [slot, db:shared]
    done_when: { files: ["evidence/after/checks.tsv"], stage_in: [検証済, 検証NG] }
    on_ng: { gate: ng_action }
  finish:
    when_stage: 検証済
    gate_before: finish_start # 着手前にも承認を得る（PR 本文をすでに更新した Issue などを人が除けるように）
    workspace: { pr: true }
    agent: { kind: claude, name: "flow-finish-{issue}" }
    done_when: { files: ["pr-body.md"] }
    gate_after: pr_body
    on_approve:
      {
        prompt: "pr_body が承認されました。pr-finish スキルの A の「了承を得て更新する」を実行し、result.json を書き直してください。",
      }
  cleanup:
    when_pr_merged: true
    gate_before: cleanup
    action: { remove_workspaces: true, command: "mise issue:status --update" }
base:
  resolve: "git -C {main} ls-remote --heads origin 'delivery/*' | sed 's#.*refs/heads/##' | sort | tail -1" # 9.1
vars:
  main: /home/user/projects/example-app
  owner: example-org
  repo: example-app
```

- `{...}` は置き換え。未定義の変数はエラー
- `locks` の `slot` は空いている slot を 1 つ取る。`db:shared` / `db:exclusive` は `resources.db`
- 段階の名前（`未着手` など）・コマンド・プロンプトはすべてプロジェクト固有。コードは `steps` の定義だけを見て動く

本文の例：

```markdown
## prompt: verify

pr-verify スキルの worktree 側（手順 3〜10）で動作確認してください。メイン側の手順 0〜2 は flow が行いました。

- PR: #{pr.number}（{pr.branch} → {pr.base}）
- Issue: #{issue.number} {issue.title}
- MAIN={vars.main} / WT={ws.path}（workspace {ws.workspaceId}、slot {ws.slot}）
- 試行: {attempt}（2 回目以降は repro.md の「進捗」から続けてください。前回の失敗：{last_failure}）
- DB リセット：了承済みです。リセットする前に `flow lock acquire db:exclusive --issue {issue.number} --wait` を実行し、終わったら `flow lock release db:exclusive --issue {issue.number}` を実行してください
- 終わったら {flow_dir}/result-verify-{attempt}.json を仕様書 3.3 の形で書いてください
```

テンプレートに渡す値：`issue`、`pr`（あれば）、`ws`、`attempt`、`last_failure`、`vars`、`flow_dir`、`issue_dir`。

## 5. tick

`flow tick` は次を順に行う。`flow run --interval 60` は tick をくり返す（二重起動しないよう、`.flow/run/flow.pid` でロックする）。

1. **設定の読み込み**：`WORKFLOW.md` を読み、検証する
2. **候補の取得**：`tracker.listCandidates()`。新しい Issue は `stageStore.ensure()` で初期状態にし、state.json を作る
3. **突き合わせ**（`running` / `waiting_*` の Issue ごと）
   - `tracker.getIssue()` が closed で、その Issue を閉じる PR がマージ済み：`cleanup` の step に進める（`gate_before: cleanup` に従う）
   - `tracker.getIssue()` が closed（マージ済みの PR なし）・アサインが外れた・見つからない：エージェントを `stop` し、`stopped` にして通知する（worktree は消さない）
   - エージェントの状態が `gone`：失敗として扱う（6 章）
   - `blocked`：`waiting_gate`（gate 名 `agent_question`）にして通知する。人がペインで答えたら、次の tick で `working` に戻ったのを見て `running` に戻す
   - `stall_ms` の間、`runner.tail()` の内容が変わらず `working` のまま：止まったとみなして失敗扱い
4. **完了の判定**：`running` の Issue で、エージェントが `idle` / `done` になったもの。`result.json` と `done_when` で ok / ng / failed を決め、`on_ok` / `on_ng` / `gate_after` に従う。step の間だけ持つロック（`db:*`）を解放する（`slot:N` は持ったまま）
5. **remote の確認**：`waiting_remote` の Issue で `remote.poll()`。`done` なら `on_done`
6. **割り振り**：`idle` の Issue を優先度（ラベルの `priority:N`。無ければ最後）→ Issue の作成日の古い順に並べ、次の step を決める
   - `gate_before` があり未承認：`waiting_gate` にして通知（承認されるまで割り振らない）
   - 全体と step ごとの同時実行数、ロックが取れるか。取れなければ次の tick に回す（`retry_wait` にはしない）
   - `workspace.ensure()` → `runner.start()`。state.json を `running` にし、ロック・エージェント・workspace を記録する
7. **記録**：`.flow/run/events.ndjson` に、1 行 1 イベント（時刻・Issue・step・内容）で追記する

1 回の tick で外部コマンドが失敗しても、他の Issue の処理は続ける。

## 6. 失敗とリトライ

- 失敗の理由（`gone`・停止・`done_when` を満たさない・`result: failed`・コマンドの失敗）を `history` に残す
- `attempt < max_attempts` なら `retry_wait`（`nextRetryAt` = 今 + `backoff_ms[attempt]`）。時刻が来たら `idle` に戻して割り振る。
  同じ workspace を再利用し、プロンプトに `attempt` と `last_failure` を渡す
- 待ち時間は `backoff_ms[n]`（n は 0 から数えたリトライの回数。1 回目のリトライは `backoff_ms[0]`）。配列より多いときは最後の値を使う
- 上限なら `failed` にして通知する。`flow retry <issue>` で `attempt` を 0 に戻して `idle` にできる
- 失敗しても、step の間だけ持つロック（`db:*`）は必ず解放する。`slot:N` は worktree を削除するまで持つ（7 章）

## 7. ロック

- ファイルロック（`.flow/run/locks/`）。プロセスをまたいで効き、持ち主（Issue と pid）を記録する。持ち主のプロセスもエージェントもいなくなったロックは、tick が解放する
- `slot:N`：worktree ごとに 1 つ。worktree を削除するまで持つ（dev のポートが worktree に紐づくため）。既にある worktree の slot は `mise wt:list` などの出力から読み取り、重ねて割り当てない
- `db`：`shared` は何人でも、`exclusive` は 1 人だけで、`shared` を持つ人がいる間は取れない
- エージェントからは CLI で取る：`flow lock acquire <resource> --issue <n> [--wait] [--timeout <ms>]`、`flow lock release <resource> --issue <n>`。
  `db:exclusive` を取るとき、その Issue が持っている `db:shared` は一時的に外す（自分自身と衝突しないように）。`--wait` は待っている間、新しい `shared` の割り振りを止める（飢餓を防ぐ）
- `gates.db_reset` が manual のときは、`acquire db:exclusive` が gate（`db_reset`）を立てて承認を待つ。auto なら待たない

### 7.1 worktree とエージェントの持ち主

flow は、**自分で作った worktree と、自分で起動したエージェントだけ**を操作する。人や別のセッションが作ったものには触らない。

- flow が worktree を作ったら、`.flow/run/owned.json` に記録する（path・branch・workspaceId・作った Issue と step・時刻）。エージェントも同じく記録する（name・paneId）
- step が使う worktree が既にあり、`owned.json` に無い（人が作った）とき：`wt:ports`・`wt:sync` も、ペインの作成も、エージェントの起動もしない。
  gate `adopt_workspace`（既定 manual）を立てて通知する。承認されたら `owned.json` に記録して使う。却下されたら `stopped`
- flow の worktree でも、その workspace に flow が起動していないエージェント（名前の無いものを含む）が `working` / `blocked` なら、使用中とみなして割り振らない（次の tick に回す）
- エージェントの名前は `flow-` で始める。同じ名前のエージェントが既にあり、`owned.json` に無いときは、プロンプトを送らずにエラーにする（乗っ取らない）
- worktree の削除（refine 完了後と cleanup）も、`owned.json` にある worktree だけを対象にする。refine 後に未コミット・未 push の変更で削除が拒否された場合は通知して保持し、cleanup で再度試みる。

## 8. gate

- `flow status`：Issue ごとに、段階・step・状態・gate・エージェント・slot・経過時間を表で表示する。`--json` もある
- `flow approve <issue> [<gate>]`：gate を承認する。`on_approve` があれば実行し（command なら実行、prompt ならエージェントに送る）、次に進める
- `flow reject <issue> [<gate>] [--reason <text>]`：gate を却下する。gate が無いとき（`retry_wait`・`failed`・`stopped`・`idle`・`done`）も、`<gate>` を省けば対象外にできる（`running` のときはエージェントを止めてから）。`stopped` にして理由を記録する（再開は `flow retry`）。
  あわせて段階を `WORKFLOW.md` の `stage_store.rejected`（example-app では `対象外`）に変える。Issue のディレクトリがまだ無いとき（dry-run で予定しただけの Issue など）は、
  `stageStore.ensure()` で作ってから変える（エラーで止めない）。`flow retry` で再開するときは、却下する前の段階に戻す（state.json に記録しておく）
- `stage_store.rejected` の段階は、どの step の `when_stage` にも書かない（flow が割り振らない）
- **保留**：候補の Issue に `tracker.hold_labels` のラベルがあると、今の step が終わるのを待ってから（`idle`、または開始の承認待ちでまだ何も動いていないとき）段階を `stage_store.held`（`保留`）にして `stopped` にする。動いているエージェント・Copilot・step の終わりの承認待ちは止めない。元の段階は state.json の `heldFromStage` に記録し、ラベルが外れたら元の段階に戻して同じ tick で再開する（開始の承認は改めて求める）。保留中の `flow retry` は元の段階に戻す（ラベルが残っていれば次の tick でまた保留になる）。保留中の `flow reject` は保留の前の段階を `rejectedFromStage` に記録する。`held` は `initial`・`rejected`・`when_stage` と別の名前にする
- `ng_action` の承認は、選択肢を付ける：`flow approve <issue> ng_action --choice copilot|self|stop`
  - `copilot`：検証の結果を PR にコメントして Copilot に直させる（コメントの本文は verify のエージェントが書いた `ng-comment.md`）。段階は「修正中」に戻す
  - `self`：何もせず `stopped`（人が直す）
  - `stop`：`stopped`
- gate が立ったら、`notifier` で `level: action` の通知を送る（何を確かめればよいか、成果物のパス、承認のコマンド）
- `gates.<name>: auto` の gate は、立てずにそのまま進める

## 9. Copilot（RemoteAgent）

- `request`：`assign` のコマンドを実行し、`waiting_remote` にする
- `poll`：`tracker.findPullRequests(issue)` で、作者が Copilot（`Copilot` / `copilot-swe-agent`。WORKFLOW.md で設定）の open な PR を探す
  - 無い：`pending`（Copilot がまだ PR を作っていない）
  - ある：作業が終わったかを判定する。判定方法は実装時に `gh api` で PR のタイムラインやレビュー依頼を調べて決め、
    WORKFLOW.md の `remote.done_when` で選べるようにする（候補：draft が外れた／Copilot からレビュー依頼が来た／タイムラインの作業完了のイベント）。
    調べた結果と選んだ既定値を README に書く
- 既に PR があるのに段階が「Issue更新済」のとき（人が手でアサインした）は、gate を立てずに `waiting_remote` にする

### 9.1 base ブランチ

マージ先の base ブランチは週ごとに変わる（example-app では `origin` にある `delivery/*` の中で一番新しいもの）。決め打ちせず、求め方を `WORKFLOW.md` の `base.resolve` にコマンドで書く。汎用のコードは「コマンドを実行し、出力の 1 行目をブランチ名にする」だけを行い、`delivery/*` などの名前のルールを持たない。

- `{base}` は、使うときに `base.resolve` を実行して求める（tick ごとに 1 回求めて使い回してよい）。出力が空・コマンドが失敗したときは、その tick で base を使う step を割り振らず、エラーを通知する
- repro の worktree は、その時点の `{base}` から作る（repro では base を固定しない）
- **Copilot にアサインする時点の `{base}` を、その Issue の base として固定する**。`state.json` の `base` に記録し、以後（PR の base の確認、テストの比較先）はこの値を使う
- 突き合わせ（5 章の 3）で、open な PR の base が `state.json` の `base` と違うとき、または `state.json` の `base` が今の `{base}` より古くなったとき（週が変わった）は、gate `base_changed`（既定 manual）を立てて通知する。
  承認の選択肢：`flow approve <issue> base_changed --choice keep|retarget`。`keep` はそのまま進める。`retarget` は PR の base を今の `{base}` に付け替え（`gh pr edit <PR> --base <base>`）、`state.json` の `base` を更新する

### 9.2 Copilot へのアサイン

`gh issue edit --add-assignee @copilot` は base を指定できないため使わない。REST API で、アサインと base を同時に渡す（public preview の機能）。

```
POST /repos/{owner}/{repo}/issues/{issue}/assignees
{ "assignees": ["copilot-swe-agent[bot]"],
  "agent_assignment": { "target_repo": "{owner}/{repo}", "base_branch": "{base}" } }
```

- 本文はオーケストレーターが一時ファイルに書き、`{assign_body}` としてコマンドに渡す（コマンドとアサインする login・`agent_assignment` の項目は WORKFLOW.md で変えられるようにする）
- 参考：https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-via-the-api
- GraphQL（`replaceActorsForAssignable` の `agentAssignment.baseRef`）でも同じことができる。REST が失敗したときに切り替えられるよう、アダプターの中で分けておく（既定は REST）
- アサインした後、Copilot が作った PR の base が固定した base と同じかを確かめる。違えば `base_changed` の gate を立てる

## 10. CLI

| コマンド                                                         | 内容                                                                                                            |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `flow tick [--dry-run]`                                          | tick を 1 回                                                                                                    |
| `flow run [--interval 60] [--dry-run]`                           | tick をくり返す（Ctrl+C で止める。動いているエージェントは止めない）。TTY では 1 つのフレームを差分で書き換える |
| `flow status [--json] [<issue>]`                                 | 一覧、または 1 件の詳細（history・gate・ログの末尾）                                                            |
| `flow answer <issue> "<回答>"`                                   | agent_question に回答し、配達を確認する                                                                         |
| `flow open <issue>`                                              | agent または Issue のタブを表示する                                                                             |
| `flow approve` / `reject` / `retry` / `stop <issue>`             | 8 章・6 章。`stop` はエージェントを止めて `stopped` にする（worktree は消さない）                               |
| `flow lock acquire` / `release` / `list`                         | 7 章                                                                                                            |
| `flow logs [<issue>] [-f]`                                       | events.ndjson を読みやすく表示                                                                                  |
| `flow validate`                                                  | WORKFLOW.md の検証だけ                                                                                          |
| `flow watch [--prime] [--timeout 600]`                           | 本番ログの承認待ち・エラーを待ち、`{ initialized, events }` を 1 行の JSON で出して終わる（10.4）               |
| `flow issue <dir\|mark\|push\|status>`                           | 同梱の Issue ディレクトリのコマンド（10.4）                                                                     |
| `flow wt <create\|list\|ports\|sync\|remove\|stop\|agent\|hook>` | 同梱の worktree のコマンド（10.4）                                                                              |

ヘルプ：`flow --help` / `flow help` で、コマンドの一覧と一言の説明を出す。`flow help <command>` / `flow <command> --help` で、そのコマンドの使い方・引数・オプション・例・関わる gate を出す（`approve` なら gate ごとの `--choice` も）。ヘルプは終了コード 0。知らないコマンドや引数の誤りは、使い方を標準エラーに出して終了コード 1 にする。ヘルプの文言は日本語にする。

`flow` は GitHub Release のアーカイブから mise で導入し、mise タスク `flow` から引数をそのまま渡して呼べるようにする。設定と実行状態は対象プロジェクトの `.flow/` に置く。

## 10.1 堅牢さと性能（レビューでの指摘）

- **1 つの不正で tick 全体を止めない**：worktree・エージェントの一覧に読めない行（detached HEAD の worktree などブランチの無い行）があっても、その行だけを無視して警告を残し、tick を続ける。tick の中で外部コマンドを呼ぶ箇所は、Issue ごとの try の中か、失敗しても他の Issue を処理できる形にする
- **外部コマンドの呼び出しを減らす**：同じ tick の中では、Issue のディレクトリのパスと段階を覚えておく（段階を変えたら覚え直す）。中身が変わっていない state.json は書かない（`updatedAt` も変えない）。`issues.json` は tick の最後に 1 回だけ書く。目安として、変化の無い Issue 1 件あたりの外部コマンドを今の半分以下にし、計測した前後の数を報告書に書く
- **GitHub への問い合わせをまとめる**：tick の最初に、まとめて取得して tick の間は使い回す。Issue ごとに `gh issue view` / `gh pr view` を呼ばない
  - 候補の Issue：今の `gh issue list`（1 回）
  - 候補ではないが state.json のある Issue（閉じた・アサインが外れたかの確認が要るもの）：まとめて 1 回（GraphQL の `nodes` や `search` など。件数が多ければ分割）
  - PR：`gh pr list --state all --json number,headRefName,baseRefName,state,isDraft,author,url,closingIssuesReferences`（1 回。件数の上限は WORKFLOW.md で設定）から、Issue ごとの PR を引く
  - `stopped`・`done`・対象外（`stage_store.rejected`）の Issue は、GitHub に問い合わせない（`flow retry` などで再開したときに問い合わせる）
  - 目安：今の約 16 件で、dry-run の tick が 10 秒以内。直す前後の所要時間と、GitHub への呼び出しの回数を報告書に書く
- **外部コマンドの失敗の記録**：終了コード・stderr の末尾（数十行）・シグナル・タイムアウトかどうかを、エラーの文言と events に残す
- **経過秒**：`startedAt`（step を始めた時刻）、無ければ状態が変わった時刻（`statusChangedAt` を足す）から数える。`updatedAt` は使わない

承認・却下・再試行・停止・回答の後は、`flow run` が動いていれば `.flow/run/wake` を置く。run は待ちの間 1 秒ごとにこのファイルを見て、あれば消して直ちに tick する。tick 中に置かれたものは、その tick の完了後に処理する（pid へのシグナルは、pid が別のプロセスに再利用されていると誤って届くため使わない）。

## 10.2 エージェントのペイン

質問待ちは `flow status <issue>` で内容とペイン末尾を確認し、`flow answer <issue> "<回答>"` で回答できる。回答は他のプロンプトと同じ方法で届いたことを確かめ、確かめられたら gate を外して `running` に戻す（agent がまた質問すれば、次の tick で gate が立ち直る）。`flow open <issue>` は agent のタブ、agent がなければ Issue タブへ移動する。

- **メインのチェックアウトで動く step**（`workspace: none`）は、`HERDR_PANE_ID` が無い（herdr の外で動いている）ときは起動せず、分かるエラーにする。起動先は下の「Issue ごとのタブ」に従う
- **Issue ごとのタブ**：メインの step は Issue ごとの `flow-<Issue番号>` タブを作成・記録し、次の step で再利用する。cleanup または対象外で閉じるが、人がペインを追加したタブは閉じずに通知する。
- **手順を外れないためのガード**：`## prompt: guard` があれば、Issue の変数で描画して `.flow/run/guard/<agent 名>.md` に書き、claude の agent を `--append-system-prompt-file` 付きで起動する。システムプロンプトに入るので、ペインで後から出された指示より優先され、step の手順に無い操作（段階の変更・コミット・push・Issue/PR の更新など）は断って flow の操作を案内する。Issue のディレクトリは段階で移動するので、ガードは run の下に置く。codex には渡さない
- **worktree の step**：worktree の `agent` タブで step の agent を1つ起動し、step のプロンプトを直接送る。質問にはそのペインで答える。完了時は `/exit` で agent を終了し、タブを残す。旧 state の worker は後片付けのため読み取る。
- **起動の直後**：エージェントが入力を受け付ける状態（herdr の `interactive_ready` や status）になるまで待ってからプロンプトを送る。フォルダの信頼確認などで `blocked` のときは送らず、`agent_question` の gate にして、人が答えた後の tick でプロンプトを送る（二重に送らない）
- **送ったプロンプトが届いたかを確かめる**：`herdr agent prompt` が成功しても、送信済みとはみなさない。送った後、エージェントが `working` になる（または出力が変わる）のを一定時間（例：30 秒）待って確かめ、確かめられてから effects に記録する
  - `idle` のまま変わらないとき：入力欄に貼られたまま Enter が届いていない可能性がある。`herdr agent read` で入力欄にプロンプトが残っているかを確かめ、残っていれば Enter を 1 回だけ送って、もう一度確かめる。入力欄が空なのに `idle` のまま、または Enter の後も変わらないときは、送り直さずに `launch_recovery`（または `operation_recovery`）の gate にする（二重送信を避ける）
  - 起動直後の初回プロンプト・承認後の続き（`on_approve.prompt`）・result.json の再依頼など、エージェントにプロンプトを送るすべての箇所で同じ確認をする
  - 起きた例：初回プロンプトが入力欄に貼られたまま Enter が届かず、エージェントは idle で止まっていたが、state.json の effects には `repro:1:initial-prompt` が記録され、status は running のままだった
- **step 完了時の agent 終了**：所有 agent を終了し、タブを残す。承認後の継続・質問待ちでは終了しない。`runner.close_on_complete`（既定 true）で制御する。

## 10.3 出力の見た目

flow の全コマンドの、人が読む出力を同じ見た目に揃える（`--json` の出力は変えない）。

- 表は `cli-table3`、色は `picocolors` を使う（広く使われていて依存が少ないため。バージョンは固定する）。自前で列を揃えたり ANSI のエスケープを書いたりしない
- 表：`status`（一覧と 1 件の詳細）、`tick` / `tick --dry-run` の結果、`lock list`、`logs`。列の幅は表示幅で揃え（全角を 2 として数える）、長い値は端末の幅に合わせて折り返すか省略する
- 色の意味を全コマンドで揃える：承認待ち（`waiting_gate`）は黄、`running` は青、`failed`・エラーは赤、`done`・成功は緑、`stopped`・対象外は灰。dry-run の `MUTATION SKIPPED` などの補足は薄く
- 色は端末（TTY）のときだけ付ける。`NO_COLOR` があれば付けない（picocolors の判定に従う）。パイプやファイルへの出力・テストでは ANSI を含めない
- `approve` / `reject` / `retry` / `stop` / `lock` は、何をしたかを 1 行で出す（例：`✔ #123 を対象外にしました（理由: ...）`）。承認待ちの通知は、Issue・gate・確かめるもの・承認のコマンドを揃った形で出す
- 時刻は日本時間（WORKFLOW.md の設定）で、`YYYY-MM-DD HH:mm:ss` の形に揃える
- 表は行の間に区切り線を入れない（見出しの下だけ）。行数を Issue の数 + 見出しに近づける
- 経過時間は秒ではなく、人が読める形にする（例：`45秒`、`12分`、`3時間5分`、`1日21時間`）。`--json` は秒のまま
- `logs` は枠のある表にしない。1 件ずつ、見出しの行（時刻・Issue・step・イベント）と、その下に字下げした内容を出す。内容は切らずに端末の幅で折り返す
- 長いパスを切るときは、前を省いて後ろ（ファイル名・ディレクトリ名）を残す（例：`…/worktrees/example-app/flow-repro-123`）。成果物のパスは Issue のディレクトリからの相対パスで出す
- `status` の並び順は段階の順にする。段階の順は WORKFLOW.md の `stage_store.order`（段階の名前の配列）で決め、コードに書かない。example-app では `.dev/issues` の並び（`mise issue:dir` のディレクトリ名の番号の順）と同じ `[対象外, 完了, 検証済, 検証NG, 修正中, Issue更新済, 再現済, 未着手]`。同じ段階の中は Issue 番号の小さい順。`order` に無い段階・段階の無い Issue は最後。`--json` も同じ順にする

## 10.4 同梱のコマンドとスキル

flow をほかのツールなしで運用できるよう、WORKFLOW.md から呼ぶ Issue ディレクトリ・worktree のコマンド、監視、運用スキルを同梱する。flow 本体の判断（0 章）には入れず、WORKFLOW.md のコマンドとして使う（差し替えられる）。

- **`flow issue` / `flow wt`**：`tools/` の bash スクリプト。flow のコマンドが引数を解釈し、mise の usage と同じ `usage_<名前>` の環境変数で渡す。`.flow/` と WORKFLOW.md は読まない。Issue のディレクトリは環境変数 `ISSUE_DIR`（メインのチェックアウトからの相対パス）の下の `<並び順>-<段階>_<番号>`、段階の並びは `ISSUE_STATUSES`。worktree の設定はメインのチェックアウトの `.herdr/worktree.json`
- **自分自身の呼び出し**：flow は起動時に、自分のパッケージの `bin/` と実行中の Node のディレクトリを `PATH` の先頭に足す。WORKFLOW.md のコマンドとスクリプトの中の `flow` は、実行中の flow と同じ版・同じ Node になる。スクリプトがほかのシェル（herdr のペイン）で flow を呼ぶときは、flow が渡す `FLOW_NODE`・`FLOW_MAIN` を使う。tick ごとに何度も呼ぶ読み取り（`stage_store.commands.dir` など）は、Node の起動を省くため `FLOW_TOOLS`（同梱スクリプトのディレクトリ）のスクリプトを直接呼んでもよい（例：`usage_number={issue} "$FLOW_TOOLS/issue/dir"`）
- **`flow watch`**：本番の `logs/<日付>/events.ndjson` を、読み取り位置（`run/watch.json`）から読む。`action`・`error`・`warning`・`command_error`・`notifier_error`・`tick_error` のイベント（dry-run を除く）が来るか timeout まで待つ。`--prime` と初回は末尾を記録するだけ。書きかけの行は次回に読み、置き換え（inode が変わる）・切り詰めは先頭から読む。二重に起動しない。state・ロック・ログは書かない
- **`skills/flow-operator/`**：メインのエージェントが `flow run` を横のペインで動かし、`flow watch` で検知した承認待ち・質問をユーザーに示し、ユーザーの判断で `approve` / `answer` などを行う運用スキル。利用先の `.claude/skills/` などに置いて使う
- Release のアーカイブには `tools/` と `skills/` を含める

## 11. ファイルの置き場所

`.flow/` の下は、**消してよいかどうか**で分ける。README に同じ表を載せる。

| ディレクトリ         | 入れるもの                                                                                                                                                                                                        | 消してよいか                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `state/`             | 永続化するもの：`owned.json`（7.1）、`locks/registry.json`（7 章）、`issues.json`（ディレクトリがまだ無い Issue）、`workflow-good.json`（最後に読めた設定）、`previews/assignment-<issue>.json`（アサインの本文） | 消さない（消すと所有・ロックが分からなくなる）                                                      |
| `run/`               | 動いている間だけ意味があるもの：`flow.pid`、`tick.pid`、`wake`（10.1）、`watch.json`（10.4）、`last-plan.json`、`dry-run/`（dry-run の仮のディレクトリ）                                                          | flow が止まっていれば消してよい（次の tick で作り直す）                                             |
| `logs/<YYYY-MM-DD>/` | ログ：`events.ndjson`（本番）、`events.dry-run.ndjson`（dry-run）。日付はローカル時刻（Asia/Tokyo）で、イベントの時刻の日に書く                                                                                   | 古い日付から消してよい。`flow logs` は既定で今日、`--date <YYYY-MM-DD>` / `--days <N>` で過去も読む |

- コードが参照するパスは 1 か所（例：`src/core/paths.ts`）にまとめる
- 古い置き場所（`run/` 直下の `owned.json`・`locks/`・`issues.json`・`workflow-good.json`・`assignment-preview-*.json`・`events.ndjson`）があれば、起動時に新しい置き場所へ移す（移した旨をログに書く）。両方にあるときは移さずエラーにする

## 12. 実装の決まり

- 置き場所は `.flow/`（git 管理外）。`.flow/` を独立したパッケージにする（`.flow/package.json`、`.flow/pnpm-workspace.yaml` を置いて、親の pnpm workspace に入らないようにする）
- CLI は commander の仕組みだけで実装する（自前の解析・ディスパッチ・ヘルプの組み立てをしない）
  - 各コマンドの処理は、そのコマンドの `.action()` に書く。解析した値を別の形（旧来の引数オブジェクトなど）に詰め直して別の関数でもう一度解析しない
  - 引数・オプションの型変換と検証は commander の `argParser`（`InvalidArgumentError`）、選べる値は `Option#choices()`、必須は `requiredOption` / `<arg>`、既定値は commander の既定値で行う
  - ヘルプは commander が組み立てる。`help` コマンドは commander の `helpCommand()` を使い、自前の help コマンドや `outputHelp` の上書きをしない。
    日本語にするのは、`configureHelp()` で `Help` のフック（`styleTitle` など見出しを出す箇所）を使って見出しを置き換える方法で行い、出来上がった文字列を後から置換しない。例や関わる gate は `addHelpText('after', ...)` で足す
  - エラーは `exitOverride()` と `configureOutput()` で受け、commander のエラーの `code`（`commander.unknownOption` など）ごとに日本語の文言を出す。終了コードは 10 章のとおり
  - オプション名は commander の慣例どおりにする（例：`logs` の追跡は `-f, --follow`）
- テストは vitest。core はアダプターを差し替えて、状態遷移・ロック・gate・リトライ・突き合わせ・冪等性をテストする（外部コマンドを呼ばない）
- アダプターは、外部コマンドの出力の解析をテストする（実際の出力の例をテストデータにする）
- README に、使い方、WORKFLOW.md の項目、状態の遷移図、プラグインにするときに分ける境界を書く
