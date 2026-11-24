// Stable IDs are command paths. Argument names and long flags are local to each command.
const issue = '正の10進整数。先頭のゼロや符号は不可。JavaScript の安全な整数の範囲で指定します。例は `123`。'
const toolIssue = 'GitHub の Issue 番号を渡す文字列。CLI は数値に変換せず Bash スクリプトに渡します。例は `123`。'
const check = '対象チェックアウトへのパス文字列。相対パスは呼び出し元から解決し、省略時はカレント。例は `../app-wt`。'
const gate = '表示された gate の名前。例は `start`。指定すると操作対象の gate が一致することを確認します。'
const reason =
    '履歴に保存する理由の文字列。空白を含む場合は引用符で囲みます。省略時の履歴は「人による停止」です。例は `--reason "確認中"`。'
const json =
    '真偽値フラグ。指定時は機械処理向けの JSON を出力します。省略時は端末向けの表と、Issue を指定していれば詳細を表示します。例は `flow status 123 --json`。前回の dry-run の予定は JSON に含みません。'
const dry =
    '真偽値フラグ。省略時は通常実行です。指定時は変更と分類した外部コマンドを SKIPPED として表示し、本番の段階・Issue 状態・資源ロックを更新しません。GitHub や Herdr への読み取りは行い、予定・診断ログなどのローカル出力を残します。設定コマンドの読み取り契約も確認してください。'
const helpCommand = (parent, child) =>
    entry(
        'サブコマンドの使い方を端末で調べるときに使います。',
        '親または指定先のヘルプを表示して終了します。',
        `${parent} help ${child}`,
        '使い方:',
        parent.replace(/^flow ?/, '') || 'flow',
        { command: `サブコマンド名の文字列。例は \`${child}\`。省略すると親のヘルプを表示します。` }
    )
function entry(use, effects, example, output, related, args = {}, options = {}) {
    return { use, effects, example, output, related, args, options }
}
export const helpOption =
    '真偽値フラグ。指定したコマンドの構文と利用できる項目を表示し、操作を実行せず終了します。省略時は指定されたコマンドを処理します。'

export const cliNotes = {
    flow: entry(
        '監視対象のプロジェクトを選び、操作を呼び出します。コマンド省略時は status が選ばれます。',
        'プロジェクト指定はサブコマンドの前に置きます。同梱の issue / wt は呼び出し元のチェックアウトから配置を見つけるので、対象リポジトリへ移動して呼び出します。',
        'flow --project ../app --json',
        '[]',
        'status',
        {},
        {
            '--project':
                '対象プロジェクトのパス文字列。省略時はカレント。相対パスはカレントから解決し、配下の .flow を使用します。例は `flow --project ../app validate`。ディレクトリ自体の存在や設定の妥当性は各操作で判断します。',
            '--json': json,
        }
    ),
    help: helpCommand('flow', 'run'),
    run: entry(
        '担当 Issue を継続監視します。最初の tick は即座に始まります。',
        'TTY では画面内を再描画します。リダイレクト時は各 tick の表を追記します。Ctrl+C または SIGTERM で進行中の tick の終了を待ってループを閉じます。エージェントは個別に stop してください。',
        'flow run',
        { scene: 'waiting' },
        'tick',
        {},
        {
            '--interval':
                '有限の正の数。単位は秒で、小数も受け付けます。既定は60。1回の tick が終わったあとに指定秒数待ち、承認などで wake が届くと待機を切り上げます。例は `flow run --interval 30`。tick 自体の実行時間は別にかかります。',
            '--dry-run': dry + ' 例は `flow run --dry-run`。1回だけ確認するには tick を使います。',
        }
    ),
    tick: entry(
        'スケジュールの1周期だけ処理するか、実行予定を確認するときに使います。',
        '通常実行では Issue の取得、状態の照合、開始・進行・完了判定を1周期行います。表示される予定と次回実行の間に GitHub の状態が変わることがあります。',
        'flow tick --dry-run',
        { scene: 'dry' },
        'run',
        {},
        { '--dry-run': dry + ' 例は `flow tick --dry-run`。' }
    ),
    status: entry(
        '現在の段階・待機理由を確認します。Issue 指定で成果物や最近のログを調べられます。',
        'GitHub 候補と保存状態を読みます。指定 Issue の詳細表示では質問中のペイン末尾も取得します。直近の dry-run が残っていれば人向け表示に別枠で載ります。',
        'flow status',
        { scene: 'status' },
        'logs',
        { issue: issue + ' 省略時は一覧。指定時はその Issue の詳細を表示します。' },
        { '--json': json }
    ),
    approve: entry(
        '成果物を確認したり、開始を許可したりしてから manual gate を進めます。',
        '対象が待機中であることを確認し、承認を保存します。完了時 gate は承認コマンドや継続プロンプトを実行する場合があります。起動中の run には wake を送ります。',
        'flow approve 123 start',
        { scene: 'approval' },
        'answer',
        { issue, gate: gate + ' 省略すると現在待っている gate を使います。質問には answer を使います。' },
        {
            '--choice': `値付きの選択肢。通常の開始・結果 gate では省略します。以下の分岐では gate に適した値を指定します。列挙外の値は Commander が拒否します。実行時に必須の選択が無い場合や keep / skip の対象条件が違う場合は flow がエラーを返します。通常 gate に不要な値を付けても目的の処理にはなりません。

| 対象 | 値 | 承認後の動作 |
| --- | --- | --- |
| ng_action | copilot | open PR 1件と ng-comment.md が必要。設定コマンドで修正依頼を送り、指定 Stage に戻し remote 待ちへ。 |
| ng_action | self | 人による対応へ切り替え、現状を停止。 |
| ng_action | stop | NG の対応を停止。 |
| base_changed | keep | 既存の固定 base を維持して再開。承認前の状態と一致することを再確認。 |
| base_changed | retarget | open PR 1件の base を更新して再開。 |
| 復旧 gate | applied | ペインや外部サービスで実行済みと確認し、処理済みとして進行。 |
| 復旧 gate | retry | 未実行と確認し、該当操作を再試行。二重実行防止のため先に結果を確認。 |
| worktree を削除する Step の開始 gate | keep | worktree を残して片付けを進め、所有記録・ロックを解放。 |
| skippable な Step の開始 gate | skip | 実行せず完了済みに記録し、次の tick に委ねる。 |

例は \`flow approve 123 ng_action --choice self\`。`,
        }
    ),
    reject: entry(
        '処理候補から Issue を外すときに使います。',
        '所有エージェントがいれば停止し、必要なら Issue ディレクトリを作成して rejected 段階へ変更します。元の段階は retry の復元用に保存します。',
        'flow reject 123 start --reason "保留を確認中"',
        '✔ #123 を対象外にしました（理由: 保留を確認中）',
        'retry',
        { issue, gate: gate + ' 省略時は gate が無くても対象外にできます。' },
        { '--reason': reason }
    ),
    retry: entry(
        '停止・失敗・再試行待ちから手動で立て直したあとに使います。',
        '対象は stopped / failed / retry_wait。動作中のエージェントがいれば失敗します。元の段階を復元可能なら復元し、試行回数・現在 Step の完了印・承認を戻します。',
        'flow retry 123',
        '✔ #123 の試行回数を戻し、再開待ちにしました',
        'stop',
        { issue }
    ),
    stop: entry(
        'Issue 単位で作業を止めます。',
        '所有を確認したエージェントと管理対象の実行を止め、gate を消去してロックを解放します。worktree は残ります。run のループを閉じる操作は Ctrl+C です。',
        'flow stop 123 --reason "手元で確認"',
        '✔ #123 を停止しました（理由: 手元で確認）',
        'retry',
        { issue },
        { '--reason': reason }
    ),
    answer: entry(
        'agent_question の回答を既存のエージェントに届けます。',
        '所有と質問状態を確認し、ペインに入力を送ります。質問が無いときは状態を見直してください。直接ペインで回答しても次の tick が再開を検出できます。',
        'flow answer 123 "設定画面の表示名です"',
        '✔ #123 の agent に回答を送りました',
        'open',
        {
            issue,
            text: '必須の回答文字列。空白を含む場合は1引数になるよう引用符で囲みます。例は `"設定画面の表示名です"`。',
        }
    ),
    open: entry(
        'Issue のエージェント画面・結果を Herdr で確認します。',
        '保存された所有対象を調べてタブにフォーカスします。登録前やタブが失われた場合は対象を確認してください。',
        'flow open 123',
        '✔ #123 のタブを開きました',
        'status',
        { issue }
    ),
    watch: entry(
        '運用ツールで承認待ち・エラーの新着だけを受け取ります。',
        '本番ログのカーソルを .flow/run/watch.json に保存します。初回は初期化を返し、以後は新着かタイムアウトで1回 JSON を返して終了します。同一プロジェクトで並行実行できません。',
        'flow watch --prime',
        '{"initialized":true,"events":[]}',
        'logs',
        {},
        {
            '--prime':
                '真偽値フラグ。既定は false。現在の本番ログ末尾にカーソルを置き、過去分を返さず初期化します。既存カーソルが無い場合も同じ動作です。例は `flow watch --prime`。',
            '--timeout':
                '有限の正の秒数。既定は600。新着が無い場合の待機上限で、空の events を返します。例は `flow watch --timeout 30`。初期化時は待ちません。',
            '--interval':
                '有限の正の秒数。既定は1。ログの再読み込み間隔です。残り時間を超える待機は切り詰めます。例は `flow watch --interval 2`。',
        }
    ),
    logs: entry(
        'エラー原因や Gate 操作の履歴を調べます。',
        '本番と dry-run のイベントを読み、時刻順に表示します。Issue 移動後のパス解決に失敗してもログは表示します。',
        'flow logs 123',
        { scene: 'logs' },
        'watch',
        { issue: issue + ' 省略すると全体イベントと全 Issue の履歴。' },
        {
            '--follow':
                '短縮形 -f。真偽値フラグで既定は false。指定時は同じ条件で約500msごとに再読し、新しいイベントだけを表示します。Ctrl+C で終了。例は `flow logs 123 -f`。',
            '--date':
                '実在する日付の文字列。書式は YYYY-MM-DD、日付境界は Asia/Tokyo。既定は指定なし。例は `--date 2026-10-20`。明示的な --days と併用できません。',
            '--days':
                '今日を含む過去の日数。正の安全な整数で既定は1。日本時間で日を区切ります。例は `flow logs --days 3`。--date と併用できません。',
        }
    ),
    init: entry(
        '対象プロジェクトで初期ファイルを用意します。',
        '設定とスキルを配置し、可能なら origin から vars を埋めます。既存ファイルはスキップします。表示された次の作業に従い設定を確認します。',
        'flow init',
        '次の作業',
        'validate'
    ),
    validate: entry(
        '初期設定後や設定変更後に Workflow の構文と設定値を検証します。',
        '無効な現行設定を過去の正常設定で代用せず検証します。設定に書いた外部コマンドは実行しません。旧状態ファイルがある場合は CLI の共通初期化で移行対象になります。',
        'flow validate',
        '✔ WORKFLOW.md: valid',
        'tick'
    ),
    lock: entry(
        '共有資源を扱うサブコマンドを選びます。',
        'サブコマンド省略時はエラーです。',
        'flow lock --help',
        'コマンド一覧:',
        'lock/list'
    ),
    'lock/help': helpCommand('flow lock', 'acquire'),
    'lock/list': entry(
        '稼働中のロックと待ち行列を確認します。',
        '設定と資源台帳を参照します。',
        'flow lock list',
        '資源',
        'lock/acquire'
    ),
    'lock/acquire': entry(
        'Issue が共有・排他資源を使う前に取得します。',
        '未定義資源はエラー。db:exclusive には追加の承認が必要になることがあります。',
        'flow lock acquire db:exclusive --issue 123 --wait --timeout 60000',
        '✔ #123 のロック db:exclusive を取得しました',
        'lock/release',
        {
            resource:
                '資源名文字列。locks.resources の名前に :shared または :exclusive を付けた値。例は `db:exclusive`。',
        },
        {
            '--issue': '所有者の必須 Issue 番号。' + issue + ' 例は `--issue 123`。',
            '--wait':
                '真偽値フラグ。既定 false では競合時にすぐ失敗。指定すると待ち行列に登録し、およそ200msごとに再試行し、終了時に待機登録を解除します。例は `--wait --timeout 60000`。',
            '--timeout':
                '0以上の有限のミリ秒数。既定0は無制限。--wait 指定時にのみ待機を制限します。例は `--wait --timeout 60000`。',
        }
    ),
    'lock/release': entry(
        '利用が終わった資源のロックを外します。',
        '指定した Issue の対象資源を解放します。',
        'flow lock release db:exclusive --issue 123',
        '✔ #123 のロック db:exclusive を解放しました',
        'lock/list',
        { resource: '取得時と同じ資源名文字列。例は `db:exclusive`。' },
        { '--issue': '取得時と同じ所有 Issue。' + issue + ' 例は `--issue 123`。' }
    ),
    issue: entry(
        'Issue ディレクトリ・段階や本文を扱う補助操作を選びます。',
        '対象の git チェックアウトから実行します。サブコマンドが必要です。',
        'flow issue --help',
        'コマンド一覧:',
        'issue/dir'
    ),
    'issue/help': helpCommand('flow issue', 'dir'),
    'issue/dir': entry(
        '成果物の現在位置を得るときに使います。',
        '段階を変えるとディレクトリ名も変わるため、保持したパスは使う前に引き直します。',
        'flow issue dir 123 --create',
        '/projects/issues/7-未着手_123',
        'issue/mark',
        { number: toolIssue },
        {
            '--create':
                '真偽値フラグ。省略時は既存の絶対パスを返し、無ければエラー。指定時は未着手のディレクトリを作り、既存ならそのパスを返します。例は `flow issue dir 123 --create`。',
        }
    ),
    'issue/mark': entry(
        'ローカルで Issue の段階を変更します。',
        'ディレクトリごとリネームするため、古いパスを使う処理に注意します。変更後はディレクトリの絶対パスを表示します。',
        'flow issue mark 123 再現済',
        '/projects/issues/6-再現済_123',
        'issue/dir',
        {
            number: toolIssue,
            status: '段階名文字列。ISSUE_STATUSES の候補から選びます。例は `再現済`。未登録の段階はエラーです。',
        }
    ),
    'issue/push': entry(
        'issue.md の下書きを GitHub の Issue 本文に反映します。',
        '反映後に GitHub 本文と一致することを確認し、該当する段階を Issue更新済 に進めます。',
        'flow issue push 123',
        '更新完了 (下書きと一致): https://github.com/example/project/issues/123',
        'issue/status',
        { number: toolIssue },
        {
            '--diff':
                '真偽値フラグ。省略時は更新を実行。指定時は読み取った GitHub 本文と issue.md の差分を表示し、公開変更と段階変更を省略します。例は `flow issue push 123 --diff`。',
        }
    ),
    'issue/status': entry(
        'ローカル段階と GitHub の PR・Issue を一覧で照合します。',
        '対象リポジトリの GitHub 情報を読み取ります。--update で段階も更新できます。',
        'flow issue status',
        '番号   状態   PR   Issue   備考',
        'status',
        {},
        {
            '--update':
                '真偽値フラグ。省略時は一覧のみ。指定時は close 済みを完了へ、条件を満たす open PR を修正中へ更新します。例は `flow issue status --update`。ディレクトリ名も変わります。',
        }
    ),
    wt: entry(
        'Herdr worktree の環境管理コマンドを選びます。',
        '対象の git チェックアウトから実行します。サブコマンドが必要です。',
        'flow wt --help',
        'コマンド一覧:',
        'wt/list'
    ),
    'wt/help': helpCommand('flow wt', 'create'),
    'wt/create': entry(
        '既存ブランチを Herdr の worktree に開きます。',
        'origin を fetch し、ローカルにブランチが無ければ追跡ブランチを作成します。同期とポート割当後に post_create を待ちます。',
        'flow wt create feature/settings',
        'worktree=/projects/app-settings workspace=w3 pane=p9',
        'wt/sync',
        { branch: 'ブランチ名文字列。ローカルまたは origin に存在する名前を指定します。例は `feature/settings`。' },
        {
            '--no-hooks':
                '真偽値フラグ。省略時は定義済みの post_sync と post_create を実行。指定時は両方を省略します。ファイル同期とポート割当は行います。例は `flow wt create feature/settings --no-hooks`。',
        }
    ),
    'wt/list': entry(
        'Herdr の workspace ID、ブランチ、チェックアウトの対応を調べます。',
        'worktree を作成・削除せず、タブ区切りで workspace、slot、branch、path を表示します。',
        'flow wt list',
        'w3\t2\tfeature/settings\t/projects/app-settings',
        'wt/ports'
    ),
    'wt/ports': entry(
        'worktree に開発ポートを割り当て直します。',
        '.ports.env の PORT_SLOT と設定済みの既存 env ファイルを書き換えます。メインのチェックアウトには割り当てません。',
        'flow wt ports ../app-wt --slot 2',
        'slot=2 web=3020',
        'wt/sync',
        { path: check },
        {
            '--slot':
                '1〜9の数字1文字。省略時は現在の slot を使い、未割当なら空いている最小の番号を選びます。明示指定が他 worktree と重複すると警告して続行します。例は `--slot 2`。',
        }
    ),
    'wt/sync': entry(
        'メイン側の設定ファイルを現在の worktree に同期します。',
        'コピーで同名ファイルを上書きし、ディレクトリ指定は既存内容を置き換えます。slot からポートを再反映します。',
        'flow wt sync ../app-wt',
        'copied: .env',
        'wt/ports',
        { path: check },
        {
            '--no-hooks':
                '真偽値フラグ。既定では設定済み post_sync を実行。指定時はそのフックを省略します。コピーとポート再割当は行います。例は `flow wt sync ../app-wt --no-hooks`。',
        }
    ),
    'wt/remove': entry(
        '不要な worktree を Herdr から削除します。',
        '対象 workspace の識別子と変更の有無を先に確認します。フックが失敗すると削除に進みません。成功時の出力は Herdr が返します。',
        'flow wt remove w3',
        '(Herdr の worktree remove の出力)',
        'wt/list',
        { workspace: 'Herdr workspace ID の文字列。例は `w3`。flow wt list で対象を特定します。' },
        {
            '--force':
                '真偽値フラグ。省略時は Herdr の通常削除。指定すると --force を Herdr に渡し、未コミット変更のある worktree も削除対象になります。例は `flow wt remove w3 --force`。',
            '--no-hooks':
                '真偽値フラグ。省略時は設定済みの pre_remove を実行。指定時は省略します。例は `flow wt remove w3 --no-hooks`。',
            '--yes':
                '互換用の真偽値フラグ。指定の有無で処理は変わらず、確認プロンプトはありません。例は `flow wt remove w3 --yes`。',
        }
    ),
    'wt/stop': entry(
        'dev タブで起動したサーバーを終了します。',
        '対象ペインに Ctrl+C を送り、対象のポートが閉じるのを待ちます。',
        'flow wt stop ../app-wt',
        'dev 停止完了 pane=p9',
        'stop',
        { path: check }
    ),
    'wt/agent': entry(
        '現在の worktree に手動作業用の Claude を起動します。',
        'agent タブを用意し、既にエージェントが動くペインではエラーで終了します。',
        'flow wt agent verify-123',
        'agent=verify-123 workspace=w3 pane=p9',
        'open',
        { name: 'Herdr に渡すエージェント識別子の文字列。例は `verify-123`。' }
    ),
    'wt/hook': entry(
        '指定の設定フックを手動実行します。',
        'チェックアウトのルートで順にコマンドを実行し、失敗したところで終了します。成功時の出力は設定したコマンドに依存します。',
        'flow wt hook post_sync ../app-wt',
        '==> post_sync: pnpm install --frozen-lockfile',
        'wt/sync',
        {
            name: 'フック名文字列。post_create、post_sync、pre_serve、pre_remove が使えます。例は `post_sync`。',
            path: check,
        }
    ),
}
