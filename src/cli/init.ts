import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { parseWorkflow } from '../core/workflow.js'
import type { Tone } from './output.js'
import { packageRoot } from './tools.js'

export type InitLine = { tone: Tone; text: string }

const exists = (file: string) =>
    fs.lstat(file).then(
        () => true,
        () => false
    )

/** owner/repo of a GitHub remote URL: https://host/o/r(.git), git@host:o/r(.git), ssh://git@host/o/r(.git). */
export function parseRemote(url: string): { owner: string; repo: string } | null {
    const match = /[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())
    return match ? { owner: match[1]!, repo: match[2]! } : null
}

async function originRemote(project: string): Promise<{ owner: string; repo: string } | null> {
    try {
        const { stdout } = await promisify(execFile)('git', ['-C', project, 'remote', 'get-url', 'origin'])
        return parseRemote(stdout)
    } catch {
        return null
    }
}

/** Writes `file` only when nothing is there yet; never overwrites. */
async function create(file: string, content: string | Buffer): Promise<boolean> {
    await fs.mkdir(path.dirname(file), { recursive: true })
    try {
        await fs.writeFile(file, content, { flag: 'wx' })
        return true
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
            return false
        }
        throw e
    }
}

/**
 * `flow init`: lays out the bundled templates in a project. Existing files are left as they are.
 * - .flow/WORKFLOW.md with vars.main and owner/repo (from the origin remote) filled in
 * - .herdr/worktree.json
 * - every bundled skill copied to .agents/skills/<name>, linked from .claude/skills/<name>
 */
export async function initProject(project: string, root = packageRoot()): Promise<InitLine[]> {
    const lines: InitLine[] = []
    const made = (rel: string, note = '') => lines.push({ tone: 'success', text: `作成: ${rel}${note}` })
    const kept = (rel: string) => lines.push({ tone: 'pending', text: `既にあるので飛ばしました: ${rel}` })

    const workflow = path.join('.flow', 'WORKFLOW.md')
    if (await exists(path.join(project, workflow))) {
        kept(workflow)
    } else {
        const remote = await originRemote(project)
        let source = (await fs.readFile(path.join(root, 'templates', 'WORKFLOW.md'), 'utf8')).replace(
            '/REPLACE_WITH_ABSOLUTE_PROJECT_PATH',
            JSON.stringify(project)
        )
        if (remote) {
            source = source
                .replace('REPLACE_WITH_GITHUB_OWNER', JSON.stringify(remote.owner))
                .replace('REPLACE_WITH_GITHUB_REPOSITORY', JSON.stringify(remote.repo))
        }
        parseWorkflow(source)
        if (await create(path.join(project, workflow), source)) {
            made(workflow, remote ? `（vars: ${remote.owner}/${remote.repo}）` : '')
            if (!remote) {
                lines.push({
                    tone: 'pending',
                    text: `git の origin から GitHub の owner・repo を読めませんでした。${workflow} の vars を書き換えてください`,
                })
            }
        } else {
            kept(workflow)
        }
    }

    const worktree = path.join('.herdr', 'worktree.json')
    if (await create(path.join(project, worktree), await fs.readFile(path.join(root, 'templates', 'worktree.json')))) {
        made(worktree)
    } else {
        kept(worktree)
    }

    const skills = (await fs.readdir(path.join(root, 'skills'), { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    for (const name of skills) {
        const copy = path.join('.agents', 'skills', name)
        if (await exists(path.join(project, copy))) {
            kept(copy)
        } else {
            await fs.mkdir(path.join(project, '.agents', 'skills'), { recursive: true })
            await fs.cp(path.join(root, 'skills', name), path.join(project, copy), {
                recursive: true,
                errorOnExist: true,
                force: false,
            })
            made(copy)
        }
        const link = path.join('.claude', 'skills', name)
        if (await exists(path.join(project, link))) {
            kept(link)
        } else {
            await fs.mkdir(path.join(project, '.claude', 'skills'), { recursive: true })
            await fs.symlink(path.join('..', '..', '.agents', 'skills', name), path.join(project, link), 'dir')
            made(link, ` → ${copy}`)
        }
    }
    return lines
}

export const nextSteps = [
    '次の作業:',
    '  1. .flow/WORKFLOW.md の base.resolve を、PR のマージ先の base を出力するコマンドにする',
    '  2. 環境変数 ISSUE_DIR を設定する（例: mise.toml の [env] に ISSUE_DIR = ".dev/issues"）',
    '  3. .gitignore に /.flow/state/・/.flow/run/・/.flow/logs/ を追加する',
    '  4. .herdr/worktree.json と .agents/skills/flow-* を、プロジェクトに合わせて書き換える',
    '  5. flow validate と flow tick --dry-run で確かめる',
].join('\n')
