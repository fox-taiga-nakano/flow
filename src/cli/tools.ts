import type { Command } from 'commander'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** One bundled script under tools/: its arguments and flags reach it as mise-style `usage_<name>` variables. */
type Tool = {
    description: string
    args?: { name: string; required: boolean; help: string }[]
    flags?: { name: string; value?: string; help: string }[]
    example: string
}
const arg = (name: string, help: string, required = true) => ({ name, required, help })

export const tools: Record<'issue' | 'wt', Record<string, Tool>> = {
    issue: {
        dir: {
            description: 'Issue のディレクトリ（<ISSUE_DIR>/<並び順>-<状態>_<番号>）の絶対パスを表示',
            args: [arg('number', 'GitHub の Issue 番号')],
            flags: [{ name: 'create', help: '無ければ「未着手」で作る' }],
            example: 'flow issue dir 3170 --create',
        },
        mark: {
            description: 'Issue の状態を変える（ディレクトリ名を <並び順>-<状態>_<番号> に変える）',
            args: [arg('number', 'GitHub の Issue 番号'), arg('status', '新しい状態（ISSUE_STATUSES の名前）')],
            example: 'flow issue mark 3170 再現済',
        },
        push: {
            description: '<Issue のディレクトリ>/issue.md で Issue 本文を更新し、GitHub の本文と一致するか確かめる',
            args: [arg('number', 'GitHub の Issue 番号')],
            flags: [{ name: 'diff', help: '更新せず、GitHub の現在の本文と下書きの差分だけを表示' }],
            example: 'flow issue push 3170 --diff',
        },
        status: {
            description: '全 Issue の状態と GitHub の PR・Issue の状態を一覧表示',
            flags: [{ name: 'update', help: 'PR が open なら「修正中」、Issue が close 済みなら「完了」に付け替える' }],
            example: 'flow issue status --update',
        },
    },
    wt: {
        create: {
            description:
                'ブランチを herdr worktree に展開し、.herdr/worktree.json に従ってコピー・ポート割り当て・フックまで行う',
            args: [arg('branch', '対象ブランチ（リモートのみでも可）')],
            flags: [{ name: 'no-hooks', help: 'フック（post_sync / post_create）を実行しない' }],
            example: 'flow wt create feature/foo',
        },
        list: {
            description:
                'worktree と herdr workspace の対応を slot と合わせて表示（workspace・slot・branch・path のタブ区切り）',
            example: 'flow wt list',
        },
        ports: {
            description: 'worktree に dev ポートの slot を割り当て、.herdr/worktree.json の env_files に反映',
            args: [arg('path', '対象 worktree（省略時はカレント）', false)],
            flags: [
                { name: 'slot', value: 'n', help: 'slot（1〜9）。省略時は割り当て済み、無ければ空いている最小の slot' },
            ],
            example: 'flow wt ports ../app-wt --slot 2',
        },
        sync: {
            description:
                'メインから .herdr/worktree.json の sync のファイルを worktree にコピーし、ポートとフックを反映',
            args: [arg('path', 'コピー先 worktree（省略時はカレント）', false)],
            flags: [{ name: 'no-hooks', help: 'post_sync フックを実行しない' }],
            example: 'flow wt sync ../app-wt',
        },
        remove: {
            description: 'worktree を削除（.herdr/worktree.json の pre_remove フックがあれば先に実行）',
            args: [arg('workspace', 'herdr の workspace ID（flow wt list で確認）')],
            flags: [
                { name: 'force', help: '未コミットの変更があっても削除する' },
                { name: 'no-hooks', help: 'pre_remove フックを実行しない' },
                { name: 'yes', help: '互換のため受け付ける（確認はしない）' },
            ],
            example: 'flow wt remove w3',
        },
        stop: {
            description: 'チェックアウトの dev タブで動いている dev サーバーを停止し、ポートが閉じるまで待つ',
            args: [arg('path', '対象のチェックアウト（省略時はカレント）', false)],
            example: 'flow wt stop ../app-wt',
        },
        agent: {
            description: 'カレントの worktree の agent タブ（flow の agent と同じタブ）で claude を起動',
            args: [arg('name', 'herdr のエージェント名（例: verify-123）')],
            example: 'flow wt agent verify-123',
        },
        hook: {
            description: '.herdr/worktree.json のフックをチェックアウトのルートで実行',
            args: [
                arg('name', 'フック名（post_create / post_sync / pre_serve / pre_remove）'),
                arg('path', '対象のチェックアウト（省略時はカレント）', false),
            ],
            example: 'flow wt hook post_sync',
        },
    },
}

/** The installed flow package: the directory that holds tools/ (dist/main.mjs in a checkout, lib/main.mjs in a release). */
export function packageRoot(from = path.dirname(fileURLToPath(import.meta.url))): string {
    for (let dir = from, i = 0; i < 4; i++, dir = path.dirname(dir)) {
        if (existsSync(path.join(dir, 'tools', 'lib', 'wt.sh'))) {
            return dir
        }
    }
    throw new Error(`flow の tools/ が見つかりません: ${from}`)
}

/** Let commands that flow runs call `flow` itself: the same package and the same Node. */
export function selfPath(env: NodeJS.ProcessEnv, root: string, node = process.execPath): string {
    const dirs = [path.join(root, 'bin'), path.dirname(node)]
    return [...dirs, ...(env.PATH ?? '').split(path.delimiter).filter((d) => d && !dirs.includes(d))].join(
        path.delimiter
    )
}

export type RunTool = (script: string, env: Record<string, string>) => Promise<number>
export const runTool: RunTool = (script, env) =>
    new Promise((resolve, reject) => {
        const child = spawn('/bin/bash', [script], { stdio: 'inherit', env: { ...process.env, ...env } })
        child.once('error', reject)
        child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
    })

const usageName = (name: string) => `usage_${name.replace(/-/g, '_')}`

/** `flow issue …` and `flow wt …`: the bundled scripts that WORKFLOW.md commands call. */
export function registerTools(
    program: Command,
    make: (parent: Command, name: string) => Command,
    run: RunTool,
    setExit: (code: number) => void,
    root = () => packageRoot(),
    main = () => process.argv[1] ?? ''
): void {
    for (const [group, entries] of Object.entries(tools) as [keyof typeof tools, Record<string, Tool>][]) {
        const parent = make(program, group).helpCommand('help [command]', 'コマンドの使い方を表示')
        parent.action(() =>
            parent.error(`引数が足りません: <${Object.keys(entries).join('|')}>`, { code: 'commander.missingArgument' })
        )
        for (const [name, tool] of Object.entries(entries)) {
            const command = make(parent, name)
                .description(tool.description)
                .addHelpText('after', `\n例: ${tool.example}`)
            for (const a of tool.args ?? []) {
                command.argument(a.required ? `<${a.name}>` : `[${a.name}]`, a.help)
            }
            for (const f of tool.flags ?? []) {
                command.option(`--${f.name}${f.value ? ` <${f.value}>` : ''}`, f.help)
            }
            command.action(async (...input: unknown[]) => {
                const values = input.slice(0, tool.args?.length ?? 0) as (string | undefined)[]
                const options = input[tool.args?.length ?? 0] as Record<string, string | boolean | undefined>
                const env: Record<string, string> = { FLOW_NODE: process.execPath, FLOW_MAIN: main() }
                ;(tool.args ?? []).forEach((a, i) => {
                    if (values[i] !== undefined) {
                        env[usageName(a.name)] = values[i]!
                    }
                })
                for (const f of tool.flags ?? []) {
                    // Commander stores --no-hooks as hooks=false; the scripts expect usage_no_hooks.
                    const key = f.name.startsWith('no-')
                        ? f.name.slice(3)
                        : f.name.replace(/-(.)/g, (_m, c: string) => c.toUpperCase())
                    const value = f.name.startsWith('no-')
                        ? options[key] === false
                            ? 'true'
                            : undefined
                        : options[key]
                    if (value !== undefined && value !== false) {
                        env[usageName(f.name)] = value === true ? 'true' : String(value)
                    }
                }
                const code = await run(path.join(root(), 'tools', group, name), env)
                if (code !== 0) {
                    setExit(code)
                }
            })
        }
    }
}
