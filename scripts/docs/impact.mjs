import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const base = process.argv[2]
if (!base || !/^[a-f0-9]{40}$/i.test(base)) {
    throw new Error('比較対象のコミット SHA が必要です')
}
const changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' })
    .trim()
    .split('\n')
const rules = [
    [/^src\/cli\/(commands|help|tools|main)\.ts$/, 'CLI リファレンスと使用例'],
    [/^src\/cli\/(display-text|output|run-frame|live-frame|runtime)\.ts$/, '端末デモと実行画面ガイド'],
    [
        /^templates\/WORKFLOW\.md$|^src\/core\/(gates|stage-order|orchestrator|types)\.ts$/,
        'Workflow 図、Stage/Gate 図、承認ガイド、Step ライフサイクル図',
    ],
    [/^src\/adapters\/(herdr|github|copilot|prompt-delivery)\.ts$|^tools\/wt\//, 'システム構成図と並列実行図'],
    [/^src\/core\/(locks|ownership|state|paths|migration)\.ts$/, '並列実行図、実行時ファイルと復旧ガイド'],
    [
        /^src\/core\/(types|workflow)\.ts$|^templates\/worktree\.json$|^tools\/lib\/wt\.sh$/,
        'Workflow と worktree 設定リファレンス',
    ],
    [/^package\.json$|^\.github\/workflows\/release\.yml$/, 'インストールとリリース手順'],
]
const matches = rules.flatMap(([pattern, pages]) => {
    const files = changed.filter((file) => pattern.test(file))
    return files.length ? [`- ${pages} (${files.map((file) => '`' + file + '`').join('、')})`] : []
})
const summary = ['## ドキュメントの確認候補', '', ...(matches.length ? matches : ['対応箇所なし']), ''].join('\n')
if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
}
console.log(summary)
