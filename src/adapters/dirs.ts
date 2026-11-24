import path from 'node:path'

import { FlowPaths } from '../core/paths.js'
import { render } from '../core/template.js'
import type { Exec, StageStore, Workflow } from '../core/types.js'

export class DirsStageStore implements StageStore {
    private paths = new Map<number, string>()
    private stages = new Map<number, string | null>()
    beginTick(): void {
        this.paths.clear()
        this.stages.clear()
        this.shadow.clear()
    }
    forget(issue: number): void {
        this.paths.delete(issue)
        this.stages.delete(issue)
    }
    readonly shadow = new Map<number, { path: string; stage: string }>()
    constructor(
        readonly exec: Exec,
        readonly config: Workflow['stage_store'],
        readonly vars: Workflow['vars'],
        readonly dryRun = false
    ) {}
    async command(name: keyof Workflow['stage_store']['commands'], issue: number, stage?: string): Promise<string> {
        const command = this.config.commands[name]
        if (!command) {
            throw new Error(`stage_store.commands.${name} が必要`)
        }
        return this.exec.run({
            command: render(command, { ...this.vars, issue, stage }, true),
            cwd: String(this.vars.main),
            mutation: name === 'set' || name === 'ensure',
        })
    }
    async dir(issue: number): Promise<string> {
        if (this.shadow.has(issue)) {
            return this.shadow.get(issue)!.path
        }
        if (this.paths.has(issue)) {
            return this.paths.get(issue)!
        }
        const output = (await this.command('dir', issue)).trim()
        if (!path.isAbsolute(output) || output.includes('\n')) {
            throw new Error(`Issue の絶対パスが取得できません: #${issue}`)
        }
        this.paths.set(issue, output)
        return output
    }
    async get(issue: number): Promise<string | null> {
        if (this.shadow.has(issue)) {
            return this.shadow.get(issue)!.stage
        }
        if (this.stages.has(issue)) {
            return this.stages.get(issue)!
        }
        if (this.config.commands.get) {
            const stage = (await this.command('get', issue)).trim() || null
            this.stages.set(issue, stage)
            return stage
        }
        let dir: string
        try {
            dir = await this.dir(issue)
        } catch (e) {
            if (/ディレクトリがありません|not found|ENOENT/i.test(String(e))) {
                this.stages.set(issue, null)
                return null
            }
            throw e
        }
        const match = new RegExp(this.config.pattern ?? '^\\d+-(.+)_\\d+$').exec(path.basename(dir))
        if (!match?.[1]) {
            throw new Error(`stage_store.pattern で段階を取得できません: ${dir}`)
        }
        this.stages.set(issue, match[1])
        return match[1]
    }
    async ensure(issue: number): Promise<string> {
        const stage = await this.get(issue)
        if (stage !== null) {
            return this.dir(issue)
        }
        const output = (await this.command('ensure', issue)).trim()
        if (this.dryRun) {
            const dir = FlowPaths.forProject(String(this.vars.main)).virtualIssue(issue)
            this.shadow.set(issue, { path: dir, stage: this.config.initial })
            return dir
        }
        if (!path.isAbsolute(output)) {
            throw new Error('stage_store.ensure の出力が絶対パスではありません')
        }
        this.paths.set(issue, output)
        this.stages.set(issue, this.config.initial)
        return output
    }
    async set(issue: number, stage: string): Promise<void> {
        const dir = this.dryRun ? await this.dir(issue) : ''
        await this.command('set', issue, stage)
        this.paths.delete(issue)
        this.stages.delete(issue)
        if (this.dryRun) {
            this.shadow.set(issue, { path: dir, stage })
        } else {
            await this.dir(issue)
            this.stages.set(issue, stage)
        }
    }
}
