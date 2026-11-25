import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { CommandError } from './command-error.js'
import { resetDatabase } from './db-reset.js'
import { Events } from './events.js'
import { artifact, atomic, exists, mutex } from './files.js'
import { approved, gateKey, makeGate } from './gates.js'
import { Locks } from './locks.js'
import { IssueTabBusyError, Ownership, OwnershipError, sameWorkspace, WorkspaceBusyError } from './ownership.js'
import { FlowPaths } from './paths.js'
import { initialState, States } from './state.js'
import { quote, render } from './template.js'
import type {
    Adapters,
    AgentHandle,
    AgentStatus,
    Gate,
    State,
    Step,
    TrackerIssue,
    TrackerPR,
    Transition,
    Workflow,
    WorkspaceInfo,
} from './types.js'

export type StatusRow = {
    issue: number
    title: string
    stage: string | null
    step: string | null
    status: string
    gate: string | null
    agent: string | null
    slot: number | null
    elapsed: number
    planned?: boolean
    error?: string
    /** How a person resolves the current gate; set only while waiting on one. */
    answer?: string
}
export function gateAnswer(issue: number, name: string, phase: Gate['phase']): string {
    if (phase === 'question') {
        return `flow answer ${issue} "<回答>"（ペインでも回答できます）`
    }
    const choice =
        name === 'ng_action'
            ? ' --choice copilot|self|stop'
            : name === 'base_changed'
              ? ' --choice keep|retarget'
              : phase === 'recovery'
                ? ' --choice applied|retry'
                : ''
    return `flow approve ${issue} ${name}${choice}`
}
export class Orchestrator {
    readonly paths: FlowPaths
    readonly states: States
    readonly locks: Locks
    readonly events: Events
    readonly owned: Ownership
    constructor(
        readonly workflow: Workflow,
        readonly a: Adapters,
        readonly rootDir: string,
        readonly dryRun = false,
        readonly output = console.log,
        readonly now = () => new Date()
    ) {
        this.paths = new FlowPaths(rootDir)
        this.states = new States(rootDir, a.stages, dryRun, workflow.steps, now)
        this.locks = new Locks(rootDir, workflow.locks, dryRun)
        this.events = new Events(rootDir, dryRun, now)
        this.owned = a.ownership ?? new Ownership(rootDir, dryRun)
    }
    private baseValue?: Promise<string | null>
    async currentBase(): Promise<string | null> {
        return (this.baseValue ??= (async () => {
            try {
                const command = render(this.workflow.base.resolve, this.workflow.vars, true)
                // pipefail also catches a failing ls-remote before sed/sort/tail.
                const output = await this.a.exec.run({
                    command: `set -o pipefail; ${command}`,
                    cwd: String(this.workflow.vars.main),
                    mutation: false,
                })
                const base = output.split(/\r?\n/)[0]?.trim()
                if (!base) {
                    throw new Error('base.resolve の出力が空です')
                }
                if (this.dryRun) {
                    this.output(`[dry-run BASE] ${base}`)
                }
                return base
            } catch (e) {
                if (e instanceof CommandError) {
                    await this.events.add(0, null, 'command_error', String(e), e.details)
                }
                await this.notify({ issue: 0, step: null } as State, 'base.resolve に失敗', String(e), 'error')
                return null
            }
        })())
    }
    baseSignature(s: State, current: string, prs: TrackerPR[]): string {
        return JSON.stringify([
            s.base,
            current,
            prs
                .filter((p) => p.state === 'open')
                .map((p) => [p.number, p.base])
                .sort((a, b) => Number(a[0]) - Number(b[0])),
        ])
    }
    async checkBase(s: State, prs: TrackerPR[]): Promise<boolean> {
        if (!s.base || s.inflight || s.launchPending) {
            return true
        }
        const current = await this.currentBase()
        if (!current) {
            return false
        }
        const open = prs.filter((p) => p.state === 'open')
        const signature = this.baseSignature(s, current, prs)
        const changed = s.base !== current || open.some((p) => p.base !== s.base)
        if (!changed && s.gate?.phase !== 'base') {
            return true
        }
        if (s.baseAccepted === signature && s.gate?.phase !== 'base') {
            return true
        }
        const previous = s.baseChange
        if (s.gate?.phase === 'base' && previous?.signature === signature) {
            return false
        }
        s.baseChange = {
            signature,
            current,
            pr: open.length === 1 ? open[0]!.number : undefined,
            resume: previous?.resume ?? s.status,
            gate: previous ? previous.gate : s.gate,
        }
        s.gate = null
        await this.gate(
            s,
            'base_changed',
            'base',
            `固定 base=${s.base}, 現在=${current}, PR=${open.map((p) => `#${p.number}:${p.base}`).join(', ') || '未作成'}。--choice keep|retarget を指定してください`
        )
        return false
    }
    async resumeBase(s: State, retarget: boolean): Promise<void> {
        const change = s.baseChange!
        if (retarget) {
            s.base = change.current
        }
        s.baseAccepted = change.signature
        s.status = change.resume
        s.gate = change.gate
        delete s.baseChange
        await this.save(s)
    }
    async agentStatus(h: AgentHandle): Promise<AgentStatus> {
        return (await this.owned.agent(h)) ? this.a.runner.status(h) : 'gone'
    }
    async promptOwned(h: AgentHandle, text: string): Promise<void> {
        await this.owned.assertAgent(h)
        await this.a.runner.prompt(h, text)
    }
    async stopOwned(h: AgentHandle): Promise<void> {
        if (await this.owned.agent(h)) {
            await this.a.runner.stop(h)
        }
    }
    async stopAndClose(s: State): Promise<void> {
        if (this.workflow.runner.close_on_complete === false) {
            if (s.agent) {
                await this.stopOwned(s.agent)
            }
            if (s.worker) {
                await this.stopOwned(s.worker)
            }
        } else {
            await this.closeCompleted(s)
        }
    }
    async closeCompleted(s: State): Promise<void> {
        if (this.workflow.runner.close_on_complete === false) {
            return
        }
        for (const role of ['agent', 'worker'] as const) {
            const h = s[role]
            if (!h || !(await this.owned.agent(h))) {
                continue
            }
            if ((await this.agentStatus(h)) === 'gone') {
                await this.notify(
                    s,
                    '完了した agent のペインを確認できません',
                    '所有物か確認できないため閉じません',
                    'info'
                )
                s[role] = null
                continue
            }
            await this.a.runner.close(h)
            if (await this.owned.agent(h)) {
                await this.owned.removeAgent(h)
            }
            s[role] = null
        }
    }
    async closeIssueTab(s: State): Promise<void> {
        try {
            if (await this.a.runner.closeIssueTab(s.issue)) {
                return
            }
            await this.notify(
                s,
                'Issue のタブを閉じませんでした',
                '人のペインまたは agent があるため確認してください',
                'info'
            )
        } catch (e) {
            if (!(e instanceof OwnershipError)) {
                throw e
            }
            await this.owned.removeTab(s.issue)
            await this.notify(
                s,
                'Issue のタブを閉じませんでした',
                `所有を確認できないため記録を外しました: ${e}`,
                'info'
            )
        }
    }
    /** Whether an agent is still working or waiting for an answer. */
    async busy(s: State): Promise<boolean> {
        for (const h of [s.agent, s.worker]) {
            if (h && ['working', 'blocked'].includes(await this.agentStatus(h))) {
                return true
            }
        }
        return false
    }
    async sendInitialPrompt(s: State): Promise<void> {
        if (s.initialPrompt === undefined || !s.agent) {
            return
        }
        await this.owned.assertAgent(s.agent)
        const ready = await this.a.runner.ready(s.agent)
        if (ready === 'blocked') {
            await this.gate(
                s,
                'agent_question',
                'question',
                '起動時の確認にペインで回答してください。初回プロンプトは未送信です'
            )
            return
        }
        if (ready === 'gone') {
            await this.fail(s, '初回プロンプト送信前に agent が見つかりません (gone)')
            return
        }
        if (ready !== 'ready') {
            return
        }
        const text = s.initialPrompt
        if (
            !(await this.command(s, 'agent 初回プロンプト', `${s.step}:${s.attempt}:initial-prompt`, {}, () =>
                this.promptOwned(s.agent!, text)
            ))
        ) {
            return
        }
        delete s.initialPrompt
        s.gate = null
        s.status = 'running'
        s.lastActivityAt = this.now().toISOString()
        await this.save(s)
    }
    async save(s: State): Promise<void> {
        await this.states.write(s)
    }
    async notify(
        s: State,
        title: string,
        body: string,
        level: 'info' | 'action' | 'error' = 'action',
        gate?: Parameters<Adapters['notifier']['notify']>[0]['gate']
    ): Promise<void> {
        await this.events.add(s.issue, s.step, level, `${title}: ${body}`)
        try {
            await this.a.notifier.notify({ issue: s.issue, title, body, level, ...(gate ? { gate } : {}) })
        } catch (e) {
            await this.events.add(
                s.issue,
                s.step,
                'notifier_error',
                String(e),
                e instanceof CommandError ? e.details : undefined
            )
        }
    }
    async gate(
        s: State,
        name: string,
        phase: Gate['phase'],
        summary: string,
        artifacts: string[] = [],
        workspace?: WorkspaceInfo
    ): Promise<void> {
        if (s.gate?.name === name && s.gate.phase === phase) {
            return
        }
        s.gate = { ...makeGate(name, phase, summary, artifacts, this.now().toISOString()), workspace }
        s.status = 'waiting_gate'
        await this.save(s)
        const dir = await this.a.stages.dir(s.issue)
        const files = artifacts.map((x) => artifact(dir, x))
        const command = gateAnswer(s.issue, name, phase)
        await this.notify(
            s,
            `承認待ち: ${name}`,
            `${summary}\n成果物: ${files.join(', ') || dir}\n${command}`,
            'action',
            {
                name,
                summary,
                artifacts: files.length ? files : [dir],
                command,
                issueDir: dir,
            }
        )
    }
    async context(s: State, issue?: TrackerIssue, pr?: TrackerPR): Promise<Record<string, unknown>> {
        const i = issue ?? (await this.a.tracker.getIssue(s.issue))
        if (!i) {
            throw new Error(`Issue がありません: #${s.issue}`)
        }
        if (!pr) {
            const related = await this.a.tracker.findPullRequests(s.issue)
            const open = related.filter((p) => p.state === 'open')
            const merged = related.filter((p) => p.state === 'merged')
            pr = open.length === 1 ? open[0] : merged.length === 1 ? merged[0] : undefined
        }
        const ws = s.workspace ?? {
            key: 'main',
            path: String(this.workflow.vars.main),
            workspaceId: '',
            branch: '',
            slot: 0,
        }
        const dir = await this.a.stages.dir(s.issue)
        return {
            ...this.workflow.vars,
            base: s.base ?? (await this.currentBase()) ?? '',
            issue: i,
            pr,
            ws: { ...ws, workspaceId: ws.workspaceId ?? '', slot: ws.slot ?? 0 },
            vars: this.workflow.vars,
            attempt: s.attempt,
            last_failure: s.history.at(-1)?.reason ?? '',
            flow_dir: FlowPaths.issueFlow(dir),
            issue_dir: dir,
        }
    }
    async command(
        s: State,
        source: string,
        key: string,
        context?: Record<string, unknown>,
        effect?: () => Promise<void>
    ): Promise<boolean> {
        if (s.effects.includes(key)) {
            return true
        }
        if (s.inflight) {
            await this.gate(s, 'operation_recovery', 'recovery', `実行済みか確認してください: ${s.inflight.command}`)
            return false
        }
        const ctx = context ?? (await this.context(s))
        const command = render(source, { ...ctx, issue: s.issue }, true)
        s.inflight = { key, command }
        await this.save(s)
        try {
            if (effect) {
                await effect()
            } else {
                await this.a.exec.run({ command, cwd: String(this.workflow.vars.main), mutation: true })
            }
        } catch (e) {
            this.a.stages.forget?.(s.issue)
            if (e instanceof CommandError) {
                await this.events.add(s.issue, s.step, 'command_error', String(e), e.details)
            }
            await this.gate(
                s,
                'operation_recovery',
                'recovery',
                `コマンドが完了したか不明です。確認してから --choice applied|retry を指定: ${command}\n${String(e)}`
            )
            return false
        }
        // Commands such as `mise issue:status --update` or `issue:push` rename the Issue directory;
        // saving to the cached path would recreate the old directory beside the moved one.
        this.a.stages.forget?.(s.issue)
        s.effects.push(key)
        delete s.inflight
        await this.save(s)
        return true
    }
    async release(s: State): Promise<void> {
        await this.locks.release(s.issue)
        s.locks = (await this.locks.list()).holders.filter((h) => h.issue === s.issue).map((h) => h.resource)
        delete s.retainResources
    }
    async fail(s: State, reason: string): Promise<void> {
        delete s.dbReset
        const previous = s.history.at(-1)
        if (
            s.attempt === 0 ||
            (previous?.result === 'failed' && previous.step === s.step && previous.attempt === s.attempt)
        ) {
            s.attempt++
        }
        if (s.status === 'waiting_remote') {
            s.remoteRetry = true
        }
        let active = false
        try {
            active = await this.busy(s)
        } catch {
            active = true
        }
        if (active) {
            s.retainResources = true
        } else {
            await this.release(s)
        }
        s.history.push({
            step: s.step,
            attempt: s.attempt,
            result: 'failed',
            reason,
            at: this.now().toISOString(),
        })
        delete s.pendingResult
        s.gate = null
        delete s.inflight
        if (s.attempt < this.workflow.retry.max_attempts) {
            s.status = 'retry_wait'
            const delays = this.workflow.retry.backoff_ms
            s.nextRetryAt = new Date(
                this.now().getTime() + delays[Math.min(Math.max(s.attempt - 1, 0), delays.length - 1)]!
            ).toISOString()
        } else {
            s.status = 'failed'
            s.nextRetryAt = null
            if (!active) {
                await this.closeCompleted(s)
            }
        }
        await this.save(s)
        await this.notify(
            s,
            '処理失敗',
            `${reason}\n${s.status === 'failed' ? `flow retry ${s.issue}` : `次回: ${s.nextRetryAt}`}`,
            'error'
        )
    }
    async removeWorkspaces(s: State, branches?: string[]): Promise<boolean> {
        const registered = (await this.owned.read()).workspaces.filter((w) => w.issue === s.issue)
        const targets = [...new Map([...registered, ...s.workspaces].map((w) => [w.path, w])).values()]
        for (const ws of targets) {
            if (branches && !branches.includes(ws.branch)) {
                continue
            }
            if (!(await this.owned.workspace(ws))) {
                continue
            }
            const current = (await this.a.workspace.list()).find((w) => sameWorkspace(w, ws))
            if (current && !s.keepWorkspaces) {
                if (await this.owned.foreignBusy(current, await this.a.runner.list())) {
                    return false
                }
                for (const a of (await this.owned.read()).agents) {
                    if (a.keepTab && a.issue === s.issue && a.workspacePath === ws.path) {
                        if ((await this.agentStatus(a)) === 'gone') {
                            await this.owned.removeAgent(a)
                        } else {
                            await this.a.runner.close(a)
                        }
                    }
                }
                await this.a.workspace.remove(ws)
            }
            await this.owned.removeWorkspace(ws)
            if (ws.slot !== null) {
                await this.locks.release(s.issue, `slot:${ws.slot}`)
                s.locks = s.locks.filter((l) => l !== `slot:${ws.slot}`)
            }
            s.workspaces = s.workspaces.filter((w) => w.path !== ws.path)
            await this.save(s)
        }
        return true
    }
    async transition(s: State, action?: Transition): Promise<void> {
        if (action?.set_stage) {
            await this.a.stages.set(s.issue, action.set_stage)
        }
        if (action?.gate && this.workflow.gates[action.gate] !== 'auto') {
            await this.gate(
                s,
                action.gate,
                'ng',
                s.pendingResult?.summary ?? '次の対応を選んでください',
                s.pendingResult?.artifacts
            )
            return
        }
        await this.closeCompleted(s)
        if (action?.remove_workspaces) {
            try {
                const values = {
                    ...this.workflow.vars,
                    issue: s.issue,
                    base: s.base ?? (await this.currentBase()) ?? '',
                }
                const branches = action.remove_workspaces.map((branch) => render(branch, values))
                if (!(await this.removeWorkspaces(s, branches))) {
                    throw new WorkspaceBusyError('人の agent が使用中です')
                }
            } catch (e) {
                await this.notify(
                    s,
                    'worktree を削除できませんでした',
                    `${String(e)}\ncleanup で再度削除を試みます`,
                    'action'
                )
            }
        }
        s.status = action?.stop ? 'stopped' : 'idle'
        s.gate = null
        if (action?.notify) {
            await this.notify(s, '確認が必要です', s.pendingResult?.summary ?? '', action.notify)
        }
        if (s.step && !s.completed.includes(s.step)) {
            s.completed.push(s.step)
        }
        delete s.pendingResult
        delete s.approvedGate
        await this.save(s)
    }
    async applyResult(s: State, step: Step): Promise<void> {
        const result = s.pendingResult!
        if (result.result === 'ng') {
            const action = step.on_ng
            if (action?.gate && approved(this.workflow, s, action.gate, 'ng')) {
                if (action.gate === 'ng_action') {
                    await this.applyNgAction(s, s.approvedGate?.decision ?? this.workflow.remote?.ng_action?.choice)
                } else {
                    const { gate: _gate, ...rest } = action
                    await this.transition(s, rest)
                }
                return
            }
            await this.transition(s, action ?? { stop: true, notify: 'action' })
            return
        }
        if (step.gate_after && !s.continuation && !approved(this.workflow, s, step.gate_after, 'after')) {
            await this.gate(s, step.gate_after, 'after', result.summary, result.artifacts)
            return
        }
        if (step.on_approve && !s.continuation) {
            if (
                step.on_approve.command &&
                !(await this.command(s, step.on_approve.command, `${s.step}:${s.attempt}:on_approve`))
            ) {
                return
            }
            if (step.on_approve.prompt) {
                await this.continueAgent(s, step.on_approve.prompt)
                return
            }
        }
        await this.transition(s, step.on_ok)
    }
    async continueAgent(s: State, source: string): Promise<void> {
        if (!s.agent) {
            throw new Error('継続する agent がありません')
        }
        await this.owned.assertAgent(s.agent)
        const dir = await this.a.stages.dir(s.issue)
        const key = `${s.step}:${s.attempt}:continue`
        s.inflight = { key, command: render(source, await this.context(s)) }
        s.continuation = true
        s.status = 'running'
        s.gate = null
        s.resultReminder = false
        delete s.pendingResult
        s.lastActivityAt = this.now().toISOString()
        await this.save(s)
        if (!this.dryRun) {
            const file = FlowPaths.result(dir, s.step, s.attempt)
            if (await exists(file)) {
                await fs.rename(file, FlowPaths.result(dir, s.step, s.attempt, '.pre-approve'))
            }
        }
        try {
            await this.promptOwned(s.agent, s.inflight.command)
        } catch (error) {
            await this.gate(
                s,
                'operation_recovery',
                'recovery',
                `継続プロンプトの到達を確認できません。再送せず --choice applied|retry で確認してください: ${String(error)}`
            )
            throw error
        }
        s.effects.push(key)
        delete s.inflight
        await this.save(s)
    }
    /**
     * flow の外で開いた・消した worktree を記録に合わせる。
     * - 記録にある worktree が一覧に無ければ、所有記録・slot のロック・state の記録を外す
     * - adopt_workspace が auto なら、誰の所有でもない worktree が、この Issue の open PR のブランチか
     *   step のブランチ（flow/repro-{issue} など）のとき引き継ぐ
     */
    async syncWorkspaces(s: State, occupied: WorkspaceInfo[]): Promise<void> {
        const main = this.workflow.vars.main ? path.resolve(String(this.workflow.vars.main)) : undefined
        // 一覧の取得が不完全（メインのチェックアウトすら無い）なら、記録を消さない
        const listed = !main || occupied.some((w) => path.resolve(w.path) === main)
        let changed = false
        if (listed)
        // Keep a snapshot while ownership and state are reconciled asynchronously.
        {
            for (const ws of Array.from(s.workspaces)) {
                if (occupied.some((w) => path.resolve(w.path) === path.resolve(ws.path))) {
                    continue
                }
                if (await this.owned.workspace(ws)) {
                    await this.owned.removeWorkspace(ws)
                }
                if (ws.slot !== null) {
                    await this.locks.release(s.issue, `slot:${ws.slot}`)
                }
                s.workspaces = s.workspaces.filter((w) => w.path !== ws.path)
                if (s.workspace?.path === ws.path) {
                    s.workspace = null
                }
                await this.events.add(s.issue, s.step, 'info', `worktree が無くなったため記録を外しました: ${ws.path}`)
                changed = true
            }
        }
        const owned = (await this.owned.read()).workspaces
        const foreign = occupied.filter(
            (w) =>
                path.resolve(w.path) !== main &&
                !owned.some((o) => path.resolve(o.path) === path.resolve(w.path)) &&
                !s.workspaces.some((x) => path.resolve(x.path) === path.resolve(w.path))
        )
        // 引き継ぎは adopt_workspace が auto のときだけ。manual なら step の開始時に承認を求める（従来どおり）
        const cleaned = s.completed.some((name) => {
            const step = this.workflow.steps[name]
            return step?.when_pr_review_requested && step.action?.remove_workspaces
        })
        if (!cleaned && foreign.length && this.workflow.gates.adopt_workspace === 'auto') {
            const branches = new Set(
                (await this.a.tracker.findPullRequests(s.issue)).filter((p) => p.state === 'open').map((p) => p.branch)
            )
            for (const step of Object.values(this.workflow.steps)) {
                if (step.workspace && step.workspace !== 'none' && step.workspace.branch) {
                    try {
                        branches.add(render(step.workspace.branch, { ...this.workflow.vars, issue: s.issue }))
                    } catch {
                        // base など、tick の時点で決まらない変数を使うブランチは対象にしない
                    }
                }
            }
            for (const w of foreign.filter((w) => branches.has(w.branch))) {
                await this.owned.addWorkspace(w, { issue: s.issue, step: s.step ?? 'adopted' }, 'adopted')
                s.workspaces.push(structuredClone(w))
                if (w.slot !== null) {
                    const held = await this.locks.acquire(['slot'], s.issue, occupied, w.path)
                    if (held) {
                        s.locks = [...new Set([...s.locks, ...held])]
                    }
                }
                await this.events.add(s.issue, s.step, 'info', `flow の外で開いた worktree を引き継ぎました: ${w.path}`)
                changed = true
            }
        }
        if (changed) {
            await this.save(s)
        }
    }
    private pendingPrSteps(s: State): [string, Step][] {
        const entries = Object.entries(this.workflow.steps)
        if (entries.some(([name, step]) => step.when_pr_merged && s.completed.includes(name))) {
            return []
        }
        return entries.filter(
            ([name, step]) =>
                (step.when_pr_merged || !!step.when_pr_review_requested?.length) && !s.completed.includes(name)
        )
    }
    private selectPrStep(pending: [string, Step][], prs: TrackerPR[]): [string, Step] | undefined {
        const merge = pending.find(([, step]) => step.when_pr_merged)
        if (merge && prs.some((pr) => pr.state === 'merged')) {
            return merge
        }
        return pending.find(([, step]) => {
            const users = new Set(step.when_pr_review_requested?.map((login) => login.toLowerCase()))
            return prs.some(
                (pr) => pr.state === 'open' && pr.requestedReviewers?.some((login) => users.has(login.toLowerCase()))
            )
        })
    }
    async reconcile(s: State, candidates: Set<number>, knownIssue?: TrackerIssue): Promise<void> {
        const pending = this.pendingPrSteps(s)
        const currentPrStep = pending.find(([name]) => name === s.step)?.[1]
        const failed = s.status === 'failed' && !s.retainResources
        if (
            s.status === 'stopped' ||
            (s.status === 'done' && pending.length === 0) ||
            (failed && !currentPrStep?.when_pr_review_requested)
        ) {
            return
        }
        if ((await this.a.stages.get(s.issue)) === this.workflow.stage_store.rejected) {
            return
        }
        const issue = knownIssue ?? (await this.a.tracker.getIssue(s.issue))
        const prs = await this.a.tracker.findPullRequests(s.issue)
        const selected = this.selectPrStep(pending, prs)
        if (failed && !selected?.[1].when_pr_merged) {
            return
        }
        if (selected && selected[0] !== s.step) {
            // PR-triggered steps take precedence over the closed-issue cancellation rule.
            if (s.agent || s.worker) {
                await this.stopAndClose(s)
            }
            await this.release(s)
            s.startedAt = null
            s.step = selected[0]
            s.status = 'idle'
            s.gate = null
            s.attempt = 0
            s.agent = null
            s.nextRetryAt = null
            s.resultReminder = false
            delete s.continuation
            delete s.pendingResult
            delete s.approvedGate
            delete s.launchPending
            delete s.initialPrompt
            delete s.inflight
            delete s.dbReset
            delete s.keepWorkspaces
            delete s.baseChange
            delete s.baseAccepted
            delete s.remoteRetry
            await this.save(s)
            return
        }
        // レビュー依頼やマージを待つ done は、PR の条件だけを確認する。
        if (s.status === 'done') {
            return
        }
        if (!currentPrStep && (!issue || issue.state === 'closed' || !candidates.has(s.issue))) {
            if ((s.agent || s.worker) && (['running', 'waiting_gate'].includes(s.status) || s.retainResources)) {
                await this.stopAndClose(s)
            }
            await this.closeIssueTab(s)
            await this.release(s)
            s.status = 'stopped'
            s.gate = null
            await this.save(s)
            await this.notify(s, '対象外のため停止', 'Issue が閉じられた、アサインが外れた、または取得条件の対象外です')
            return
        }
        if (!currentPrStep && !(await this.checkBase(s, prs))) {
            return
        }
        if (s.retainResources && (s.agent || s.worker)) {
            if (await this.busy(s)) {
                return
            }
            await this.release(s)
            if (s.status === 'failed') {
                await this.closeCompleted(s)
            }
            await this.save(s)
        }
        if (s.status === 'failed') {
            return
        }
        if (s.status === 'idle' && s.pendingResult) {
            const step = this.workflow.steps[s.step!]
            if (!step) {
                throw new Error('結果に対応する step がありません')
            }
            if (s.approvedGate?.phase === 'ng') {
                await this.applyNgAction(s, s.approvedGate.decision)
            } else {
                await this.applyResult(s, step)
            }
            return
        }
        if (s.launchPending && s.status !== 'waiting_gate') {
            await this.gate(
                s,
                'launch_recovery',
                'recovery',
                '起動・プロンプトの送信状況をペインで確認し --choice applied|retry を指定してください'
            )
            return
        }
        if (s.inflight && s.status !== 'waiting_gate') {
            await this.gate(s, 'operation_recovery', 'recovery', `コマンドの実行状況を確認: ${s.inflight.command}`)
            return
        }
        if (s.dbReset && (!s.gate || s.gate.phase === 'db')) {
            await resetDatabase(this, s)
            return
        }
        if (
            s.initialPrompt !== undefined &&
            ['running', 'waiting_gate'].includes(s.status) &&
            (!s.gate || s.gate.phase === 'question')
        ) {
            await this.sendInitialPrompt(s)
            return
        }
        if (s.status === 'retry_wait' && s.nextRetryAt && this.now().getTime() >= Date.parse(s.nextRetryAt)) {
            // Do not restart a still-live agent after a stall or command error.
            if (await this.busy(s)) {
                return
            }
            s.status = 'idle'
            s.nextRetryAt = null
            await this.save(s)
        }
        if (s.status === 'waiting_remote') {
            const step = this.workflow.steps[s.step!]!
            const result = await this.a.remote(step).poll(s.issue, s.remoteSince)
            if (result === 'done') {
                await this.transition(s, step.on_done)
                await this.events.add(s.issue, s.step, 'remote_done', 'remote 完了')
            } else if (result === 'failed') {
                await this.fail(s, 'remote agent が失敗しました')
            }
            return
        }
        if (!s.agent || !['running', 'waiting_gate'].includes(s.status)) {
            return
        }
        if (s.status === 'waiting_gate' && s.gate?.phase !== 'question') {
            return
        }
        const status = await this.agentStatus(s.agent)
        if (status === 'gone') {
            await this.fail(s, 'agent が見つかりません (gone)')
            return
        }
        if (s.status === 'waiting_gate' && s.gate?.phase === 'question') {
            if (status === 'working') {
                s.status = 'running'
                s.gate = null
                s.lastActivityAt = this.now().toISOString()
                await this.save(s)
            } else {
                return
            }
        }
        if (status === 'blocked') {
            await this.gate(s, 'agent_question', 'question', 'ペインで agent の質問に回答してください')
            return
        }
        if (status === 'working') {
            await this.owned.assertAgent(s.agent)
            const tail = await this.a.runner.tail(s.agent, 80)
            const hash = createHash('sha256').update(tail).digest('hex')
            if (hash !== s.tailHash) {
                s.tailHash = hash
                s.lastActivityAt = this.now().toISOString()
            } else if (this.now().getTime() - Date.parse(s.lastActivityAt) >= this.workflow.stall_ms) {
                await this.fail(s, 'agent の出力が停滞しています')
                return
            }
            await this.save(s)
            return
        }
        const result = await this.states.result(s)
        if (!result) {
            if (!s.resultReminder) {
                const text = `仕様書3.3の形式で ${FlowPaths.result(await this.a.stages.dir(s.issue), s.step, s.attempt)} を書いてください。`
                const key = `${s.step}:${s.attempt}:${s.continuation ? 'continue:' : ''}result-reminder`
                if (
                    await this.command(s, 'agent result.json 再依頼', key, {}, () => this.promptOwned(s.agent!, text))
                ) {
                    s.resultReminder = true
                    await this.save(s)
                }
            } else {
                await this.fail(s, 'result.json がありません（再依頼済み）')
            }
            return
        }
        if (result.result === 'blocked') {
            if (result.db_reset) {
                if (!this.workflow.steps[s.step!]?.db_reset || !s.workspace) {
                    throw new Error('この step では DB リセットを依頼できません')
                }
                const key = `${s.step}:${s.attempt}:db-reset:${result.db_reset.id}`
                if (s.effects.includes(`${key}:reset`)) {
                    throw new Error('実行済みの DB リセット依頼 ID は再利用できません')
                }
                s.dbReset = { ...result.db_reset, key, workspace: structuredClone(s.workspace) }
                await this.save(s)
                await this.events.add(
                    s.issue,
                    s.step,
                    'db_reset_requested',
                    `${result.db_reset.id}: ${result.db_reset.reason}`
                )
                await resetDatabase(this, s)
                return
            }
            await this.gate(s, 'agent_question', 'question', result.needs!, result.artifacts)
            return
        }
        if (result.result === 'failed') {
            await this.fail(s, result.summary)
            return
        }
        const step = this.workflow.steps[s.step!]
        if (!step) {
            throw new Error(`step が削除されました: ${s.step}`)
        }
        if (result.result === 'ok' || result.result === 'ng') {
            const dir = await this.a.stages.dir(s.issue)
            for (const file of step.done_when?.files ?? []) {
                if (!(await exists(artifact(dir, file)))) {
                    await this.fail(s, `done_when のファイルがありません: ${file}`)
                    return
                }
            }
            if (
                step.done_when?.stage_in &&
                !step.done_when.stage_in.includes((await this.a.stages.get(s.issue)) ?? '')
            ) {
                await this.fail(s, 'done_when.stage_in を満たしていません')
                return
            }
        }
        await this.release(s)
        s.pendingResult = result
        s.history.push({
            step: s.step,
            attempt: s.attempt,
            result: result.result,
            reason: result.summary,
            at: this.now().toISOString(),
        })
        await this.save(s)
        await this.applyResult(s, step)
    }
    async select(s: State): Promise<[string, Step] | null> {
        const stage = (await this.a.stages.get(s.issue)) ?? this.workflow.stage_store.initial
        if ([this.workflow.stage_store.rejected, this.workflow.stage_store.held].includes(stage)) {
            return null
        }
        const prs = await this.a.tracker.findPullRequests(s.issue)
        const pending = this.pendingPrSteps(s)
        const prStep = this.selectPrStep(pending, prs) ?? pending.find(([name]) => name === s.step)
        if (prStep) {
            return prStep
        }
        const choices = Object.entries(this.workflow.steps).filter(([, step]) => step.when_stage === stage)
        if (choices.length > 1) {
            throw new Error(`段階 ${stage} に複数の step があります`)
        }
        const selected = choices[0]
        return selected && !s.completed.includes(selected[0]) ? selected : null
    }
    /**
     * Hold label → held stage, waiting for the current step to end (idle, or a start gate where nothing runs yet).
     * Without the label the Issue returns to the stage it was held from and continues in this tick.
     */
    async syncHold(s: State, issue?: TrackerIssue): Promise<void> {
        const held = this.workflow.stage_store.held
        const labels = this.workflow.tracker.hold_labels
        if (!held || !labels || !issue) {
            return
        }
        const labelled = issue.labels.some((l) => labels.includes(l))
        const stage = await this.a.stages.get(s.issue)
        if (labelled) {
            if (stage === held || stage === this.workflow.stage_store.rejected) {
                return
            }
            if (s.status !== 'idle' && !(s.status === 'waiting_gate' && s.gate?.phase === 'before')) {
                return
            }
            s.heldFromStage = stage ?? this.workflow.stage_store.initial
            // Save the original stage before issue:mark moves the entire directory.
            await this.save(s)
            await this.a.stages.set(s.issue, held)
            s.status = 'stopped'
            s.gate = null
            await this.save(s)
            await this.events.add(s.issue, s.step, 'held', `${s.heldFromStage} → ${held}`)
            await this.notify(
                s,
                '保留',
                `ラベルにより ${s.heldFromStage} から ${held} にしました。ラベルを外すと再開します`,
                'info'
            )
            return
        }
        if (s.status !== 'stopped' || s.heldFromStage === undefined || stage !== held) {
            return
        }
        const from = s.heldFromStage
        await this.a.stages.set(s.issue, from)
        delete s.heldFromStage
        s.status = 'idle'
        await this.save(s)
        await this.events.add(s.issue, s.step, 'unheld', `${held} → ${from}`)
        await this.notify(s, '保留を解除', `ラベルが外れたため ${from} から再開します`, 'info')
    }
    async dispatch(s: State, issue: TrackerIssue, all: State[]): Promise<void> {
        if (s.status !== 'idle') {
            return
        }
        const selected = await this.select(s)
        if (!selected) {
            s.status = 'done'
            await this.save(s)
            return
        }
        const [name, step] = selected
        if (s.step !== name) {
            delete s.issueTabBusy
            s.step = name
            s.startedAt = null
            s.attempt = 0
            s.resultReminder = false
            delete s.continuation
            delete s.pendingResult
        }
        const remote = step.remote ? this.a.remote(step) : undefined
        if (remote && !s.remoteRetry && (await remote.hasOpenPullRequest(s.issue))) {
            s.status = 'waiting_remote'
            s.attempt = Math.max(1, s.attempt)
            s.gate = null
            await this.save(s)
            return
        }
        let resolved: string | null | undefined
        if (step.agent || step.remote || (step.workspace && step.workspace !== 'none' && step.workspace.from_base)) {
            resolved = await this.currentBase()
            if (!resolved) {
                return
            }
        }
        let assignment: { body: unknown; command: string } | undefined
        if (remote && this.dryRun) {
            assignment = await remote.prepare(s.issue, resolved!)
            const file = this.paths.assignment(s.issue)
            await atomic(file, assignment.body)
            this.output(
                `[dry-run ASSIGN PREVIEW; 承認前は実行予定なし] #${s.issue}\n${JSON.stringify(assignment.body, null, 2)}\n${render(assignment.command, { ...this.workflow.vars, issue: s.issue, base: resolved, assign_body: file }, true)}`
            )
        }
        if (step.gate_before && !approved(this.workflow, s, step.gate_before, 'before')) {
            await this.gate(s, step.gate_before, 'before', `${name} を開始してよいか確認してください`)
            return
        }
        const active = all.filter(
            (x) =>
                x.status === 'running' ||
                x.baseChange?.resume === 'running' ||
                (x.baseChange?.resume === 'waiting_gate' &&
                    ['question', 'db'].includes(x.baseChange.gate?.phase ?? '')) ||
                (x.status === 'waiting_gate' && ['question', 'db'].includes(x.gate?.phase ?? ''))
        )
        if (
            active.length >= this.workflow.concurrency.global ||
            active.filter((x) => x.step === name).length >=
                (this.workflow.concurrency.per_step[name] ?? this.workflow.concurrency.global)
        ) {
            return
        }
        if (remote) {
            if (!s.remoteRetry && s.effects.includes(`${name}:${s.attempt}:request`)) {
                s.status = 'waiting_remote'
                await this.save(s)
                return
            }
            assignment ??= await remote.prepare(s.issue, resolved!)
            await fs.mkdir(this.paths.run, { recursive: true })
            const temp = await fs.mkdtemp(this.paths.assignmentTemp)
            const file = FlowPaths.assignmentBody(temp)
            try {
                await fs.writeFile(file, JSON.stringify(assignment.body, null, 2), { mode: 0o600 })
                s.base = resolved!
                delete s.baseAccepted
                s.attempt++
                s.remoteSince = this.now().toISOString()
                s.startedAt = s.remoteSince
                await this.save(s)
                const ctx = { ...this.workflow.vars, issue: s.issue, base: s.base, assign_body: file }
                const command = render(assignment.command, ctx, true)
                if (
                    !(await this.command(s, assignment.command, `${name}:${s.attempt}:request`, ctx, () =>
                        remote.request({ command })
                    ))
                ) {
                    return
                }
            } finally {
                await fs.rm(temp, { recursive: true, force: true })
            }
            s.status = 'waiting_remote'
            delete s.remoteRetry
            await this.save(s)
            return
        }
        if (step.action) {
            s.attempt++
            if (step.action.remove_workspaces && !(await this.removeWorkspaces(s))) {
                s.attempt--
                await this.save(s)
                return
            }
            if (step.action.command && !(await this.command(s, step.action.command, `${name}:action`))) {
                return
            }
            if (step.action.remove_workspaces) {
                await this.closeIssueTab(s)
            }
            delete s.keepWorkspaces
            s.completed.push(name)
            s.status = 'done'
            s.gate = null
            await this.save(s)
            return
        }
        const open = prs.filter((p) => p.state === 'open')
        if (step.workspace !== 'none' && step.workspace?.pr && open.length !== 1) {
            throw new Error(`open PR が1件必要です（${open.length}件）`)
        }
        const pr = open[0]
        const branch =
            step.workspace && step.workspace !== 'none'
                ? step.workspace.pr
                    ? pr!.branch
                    : render(step.workspace.branch!, {
                          ...this.workflow.vars,
                          issue: s.issue,
                          base: resolved,
                      })
                : ''
        const occupied = await this.a.workspace.list()
        const existing = occupied.find((w) => w.branch === branch)
        const agentName = render(step.agent!.name, { ...this.workflow.vars, issue: s.issue })
        if (!/^flow-[a-z0-9_-]{1,27}$/.test(agentName)) {
            throw new OwnershipError(`agent 名は flow- で始めてください: ${agentName}`)
        }
        const agents = await this.a.runner.list()
        const named = agents.find((a) => a.name === agentName)
        if (named && !(await this.owned.liveAgent(named))) {
            throw new OwnershipError(`同名の agent は flow の所有物ではありません: ${agentName}`)
        }
        if (existing && !(await this.owned.workspace(existing))) {
            if (this.workflow.gates.adopt_workspace === 'auto') {
                await this.owned.addWorkspace(existing, { issue: s.issue, step: name }, 'adopted')
            } else {
                await this.gate(
                    s,
                    'adopt_workspace',
                    'adopt',
                    `既存の worktree を flow に引き継いでよいか確認してください: ${existing.path} (${existing.branch}, workspace=${existing.workspaceId ?? '-'})`,
                    [],
                    existing
                )
                return
            }
        }
        if (existing && (await this.owned.foreignBusy(existing, agents))) {
            return
        }
        const lockList = [...(step.locks ?? [])]
        if (step.workspace && step.workspace !== 'none' && !lockList.includes('slot')) {
            lockList.unshift('slot')
        }
        const held = await this.locks.acquire(lockList, s.issue, occupied, existing?.path)
        if (!held) {
            return
        }
        s.locks = [...new Set([...s.locks, ...held])]
        await this.save(s)
        s.attempt++
        s.startedAt = this.now().toISOString()
        s.lastActivityAt = s.startedAt
        s.resultReminder = false
        delete s.tailHash
        let ws: WorkspaceInfo
        if (step.workspace && step.workspace !== 'none') {
            ws = await this.a.workspace.ensure({
                key: step.workspace.pr ? `pr-${pr!.number}` : `${name}-${s.issue}`,
                owner: { issue: s.issue, step: name },
                branch,
                base: step.workspace.from_base
                    ? render(step.workspace.from_base, {
                          ...this.workflow.vars,
                          issue: s.issue,
                          base: resolved,
                      })
                    : undefined,
            })
            if (!existing) {
                await this.owned.addWorkspace(ws, { issue: s.issue, step: name }, 'created')
            } else {
                await this.owned.assertWorkspace(ws)
            }
            const slot = held.find((x) => x.startsWith('slot:'))
            if (slot) {
                const n = Number(slot.split(':')[1])
                if (ws.slot !== null && ws.slot !== n) {
                    throw new Error(`worktree slot (${ws.slot}) と予約 slot (${n}) が一致しません`)
                }
                ws.slot = n
                await this.locks.bindSlot(s.issue, n, ws.path)
            }
            s.workspace = ws
            if (!s.workspaces.some((x) => x.path === ws.path)) {
                s.workspaces.push(ws)
            }
            await this.save(s)
            await this.a.workspace.sync(ws)
        } else {
            ws = {
                key: 'main',
                path: String(this.workflow.vars.main),
                workspaceId: null,
                branch: '',
                slot: null,
            }
            s.workspace = ws
        }
        const context = await this.context(s, issue, pr)
        const dir = await this.a.stages.dir(s.issue)
        const prompt = render(this.workflow.prompts[name]!, context)
        // The guard goes into the system prompt so later instructions in the pane cannot override the step.
        const guard = this.workflow.prompts.guard ? render(this.workflow.prompts.guard, context) : null
        const guardFile = (agent: string) => (guard ? this.paths.guard(agent) : undefined)
        if (!this.dryRun) {
            if (guard) {
                await fs.mkdir(path.dirname(this.paths.guard(agentName)), { recursive: true })
                await fs.writeFile(this.paths.guard(agentName), `${guard}\n`)
            }
            const resultFile = FlowPaths.result(dir, name, s.attempt)
            if (await exists(resultFile)) {
                await fs.rename(resultFile, `${resultFile}.${Date.now()}.previous`)
            }
        }
        const owner = { issue: s.issue, step: name }
        s.agent = { runner: 'herdr', name: agentName }
        s.initialPrompt = prompt
        s.launchPending = true
        s.status = 'running'
        await this.save(s)
        s.agent = await this.a.runner.start({
            name: agentName,
            ws,
            kind: step.agent!.kind,
            owner,
            place: ws.key === 'main' ? 'main' : 'worktree',
            systemPromptFile: guardFile(agentName),
        })
        await this.owned.addAgent(s.agent, owner, ws)
        delete s.issueTabBusy
        s.launchPending = false
        await this.save(s)
        await this.sendInitialPrompt(s)
        await this.events.add(s.issue, name, 'started', `attempt=${s.attempt} agent=${agentName}`)
    }
    async handleError(s: State, error: unknown): Promise<void> {
        try {
            if (error instanceof CommandError) {
                await this.events.add(s.issue, s.step, 'command_error', String(error), error.details)
            }
            if (error instanceof WorkspaceBusyError) {
                if (error instanceof IssueTabBusyError && !s.issueTabBusy) {
                    s.issueTabBusy = true
                    await this.notify(s, 'Issue のタブが使用中です', String(error), 'info')
                } else if (!(error instanceof IssueTabBusyError)) {
                    delete s.issueTabBusy
                }
                await this.release(s)
                s.status = 'idle'
                s.attempt = Math.max(0, s.attempt - 1)
                delete s.launchPending
                delete s.initialPrompt
                if (!s.inflight) {
                    delete s.baseChange
                }
                delete s.baseAccepted
                await this.save(s)
                return
            }
            delete s.issueTabBusy
            if (s.launchPending) {
                await this.gate(s, 'launch_recovery', 'recovery', String(error))
            } else if (s.inflight) {
                await this.gate(s, 'operation_recovery', 'recovery', String(error))
            } else {
                await this.fail(s, String(error))
            }
        } catch (handlerError) {
            await this.notify(
                s,
                '状態の保存・失敗処理に失敗したためスキップ',
                `${String(error)} / ${String(handlerError)}`,
                'error'
            )
        }
    }
    async tick(): Promise<StatusRow[]> {
        return mutex(this.paths.tickPid, async () => {
            this.baseValue = undefined
            await this.owned.read()
            this.a.stages.beginTick?.()
            await this.states.beginTick()
            try {
                this.a.tracker.beginTick?.()
                const candidates = await this.a.tracker.listCandidates()
                const byNumber = new Map(candidates.map((i) => [i.number, i]))
                const numbers = [...new Set([...(await this.states.numbers()), ...byNumber.keys()])]
                const loaded: (State | undefined)[] = Array.from({ length: numbers.length })
                const queue = numbers.entries()
                // Resolve independent Issue directories/states with bounded concurrency.
                // Keep the original order; reconciliation and dispatch remain sequential.
                await Promise.all(
                    Array.from({ length: Math.min(4, numbers.length) }, async () => {
                        for (const [index, n] of queue) {
                            try {
                                if (byNumber.has(n)) {
                                    await this.a.stages.ensure(n)
                                }
                                const s = (await this.states.read(n)) ?? initialState(n, this.now().toISOString())
                                loaded[index] = s
                            } catch (e) {
                                if (e instanceof CommandError) {
                                    await this.events.add(n, null, 'command_error', String(e), e.details)
                                }
                                await this.notify(
                                    initialState(n),
                                    'state を読み取れないためスキップ',
                                    String(e),
                                    'error'
                                )
                            }
                        }
                    })
                )
                const states: State[] = []
                for (const s of loaded) {
                    if (!s) {
                        continue
                    }
                    try {
                        // Save/register in the original order, independent of read completion.
                        await this.save(s)
                        states.push(s)
                    } catch (e) {
                        if (e instanceof CommandError) {
                            await this.events.add(s.issue, null, 'command_error', String(e), e.details)
                        }
                        await this.notify(s, 'state を保存できないためスキップ', String(e), 'error')
                    }
                }
                const active: State[] = []
                for (const s of states) {
                    try {
                        if (s.status === 'stopped' || (s.status === 'done' && this.pendingPrSteps(s).length === 0)) {
                            continue
                        }
                        if ((await this.a.stages.get(s.issue)) === this.workflow.stage_store.rejected) {
                            continue
                        }
                        active.push(s)
                    } catch (e) {
                        await this.handleError(s, e)
                    }
                }
                // The GitHub snapshot and workspace listing are independent reads.
                await Promise.all([
                    this.a.tracker.prepareTick?.(active.map((s) => s.issue)),
                    (async () => {
                        try {
                            const occupied = await this.a.workspace.list()
                            await this.locks.reclaim(occupied, async (n) => {
                                const s = states.find((s) => s.issue === n)
                                // Unknown/corrupt state must never cause a potentially live owner's lock to be removed.
                                if (!s) {
                                    return true
                                }
                                return !!s.agent && (await this.agentStatus(s.agent)) !== 'gone'
                            })
                        } catch (e) {
                            if (e instanceof CommandError) {
                                await this.events.add(0, null, 'command_error', String(e), e.details)
                            }
                            await this.notify(
                                initialState(0),
                                '一覧の取得・ロック回収に失敗したため回収をスキップ',
                                String(e),
                                'error'
                            )
                        }
                    })(),
                ])
                const candidateNumbers = new Set(byNumber.keys())
                try {
                    const occupied = await this.a.workspace.list()
                    for (const s of active) {
                        try {
                            await this.syncWorkspaces(s, occupied)
                        } catch (e) {
                            await this.handleError(s, e)
                        }
                    }
                } catch (e) {
                    if (e instanceof CommandError) {
                        await this.events.add(0, null, 'command_error', String(e), e.details)
                    }
                }
                for (const s of active) {
                    try {
                        await this.reconcile(s, candidateNumbers, byNumber.get(s.issue))
                    } catch (e) {
                        await this.handleError(s, e)
                    }
                }
                const priority = (i?: TrackerIssue) =>
                    Math.min(
                        Infinity,
                        ...(i?.labels ?? [])
                            .map((l) => /^priority:(\d+)$/.exec(l))
                            .filter(Boolean)
                            .map((m) => Number(m![1]))
                    )
                states.sort(
                    (a, b) =>
                        priority(byNumber.get(a.issue)) - priority(byNumber.get(b.issue)) ||
                        (byNumber.get(a.issue)?.createdAt ?? '').localeCompare(
                            byNumber.get(b.issue)?.createdAt ?? ''
                        ) ||
                        a.issue - b.issue
                )
                for (const s of states) {
                    try {
                        await this.syncHold(s, byNumber.get(s.issue))
                        if (s.status !== 'idle') {
                            continue
                        }
                        if ((await this.a.stages.get(s.issue)) === this.workflow.stage_store.rejected) {
                            continue
                        }
                        const issue = byNumber.get(s.issue) ?? (await this.a.tracker.getIssue(s.issue))
                        if (issue) {
                            await this.dispatch(s, issue, states)
                        }
                    } catch (e) {
                        await this.handleError(s, e)
                    }
                }
                const rows = await this.rows(states, candidates)
                if (this.dryRun) {
                    await atomic(this.paths.plan, rows)
                }
                return rows
            } finally {
                this.a.tracker.endTick?.()
                await this.states.endTick()
            }
        })
    }
    async rows(states: State[], issues: TrackerIssue[]): Promise<StatusRow[]> {
        // slot は worktree の記録ではなく、実際に持っている slot のロックから出す（flow の外で worktree を消しても古い値を出さない）
        const holders = (await this.locks.list()).holders
        const heldSlot = (s: State): number | null => {
            const slots = holders
                .filter((h) => h.issue === s.issue && /^slot:\d+$/.test(h.resource))
                .map((h) => Number(h.resource.slice('slot:'.length)))
            if (!slots.length) {
                return null
            }
            return s.workspace?.slot != null && slots.includes(s.workspace.slot) ? s.workspace.slot : slots[0]!
        }
        return Promise.all(
            states.map(async (s) => {
                let stage: string | null = null
                let error: string | undefined
                try {
                    stage = await this.a.stages.get(s.issue)
                } catch (e) {
                    if (e instanceof CommandError) {
                        await this.events.add(s.issue, s.step, 'command_error', String(e), e.details)
                    }
                    error = String(e)
                }
                return {
                    issue: s.issue,
                    title: issues.find((i) => i.number === s.issue)?.title ?? '',
                    stage,
                    error,
                    step: s.step,
                    status: s.status,
                    gate: s.gate?.name ?? null,
                    answer:
                        s.status === 'waiting_gate' && s.gate
                            ? gateAnswer(s.issue, s.gate.name, s.gate.phase)
                            : undefined,
                    agent: s.agent?.name ?? null,
                    slot: heldSlot(s),
                    elapsed: Math.max(
                        0,
                        Math.floor(
                            (this.now().getTime() -
                                Date.parse(s.startedAt ?? s.statusChangedAt ?? this.now().toISOString())) /
                                1000
                        )
                    ),
                    planned: this.dryRun,
                }
            })
        )
    }
    async approveState(s: State, name?: string, choice?: string): Promise<void> {
        const g = s.gate
        if (!g || s.status !== 'waiting_gate' || (name && name !== g.name)) {
            throw new Error('該当する gate がありません')
        }
        const step = this.workflow.steps[s.step!]
        if (g.phase === 'base') {
            if (!['keep', 'retarget'].includes(choice ?? '')) {
                throw new Error('base_changed は --choice keep|retarget が必要')
            }
            this.baseValue = undefined
            const current = await this.currentBase()
            const prs = await this.a.tracker.findPullRequests(s.issue)
            if (!current || !s.baseChange || this.baseSignature(s, current, prs) !== s.baseChange.signature) {
                throw new Error('base または PR が変更されています。tick で gate を更新してから再確認してください')
            }
            if (choice === 'retarget') {
                if (!s.baseChange.pr) {
                    throw new Error('retarget には open PR が1件必要です')
                }
                s.baseChange.retarget = true
                await this.save(s)
                const command = `gh pr edit ${s.baseChange.pr} --base ${quote(current)}`
                if (!(await this.command(s, command, `base-retarget:${s.baseChange.signature}`, {}))) {
                    return
                }
            }
            await this.resumeBase(s, choice === 'retarget')
            return
        }
        if (g.name === 'ng_action' && !['copilot', 'self', 'stop'].includes(choice ?? '')) {
            throw new Error('ng_action は --choice copilot|self|stop が必要')
        }
        if (choice === 'keep') {
            if (g.phase !== 'before' || !step?.action?.remove_workspaces) {
                throw new Error(`keep は worktree を消す step（cleanup）の開始 gate だけに使えます（${g.name}）`)
            }
            // 記録とロックは外すが、worktree は消さない（下の承認の続きで実行）
            s.keepWorkspaces = true
        }
        if (choice === 'skip') {
            if (g.phase !== 'before' || !step?.skippable) {
                throw new Error(`skip は skippable な step の開始 gate だけに使えます（${g.name}）`)
            }
            // agent・worktree・remote を使わず、step が ok で終わったのと同じ状態にする。次の tick で次の step か done になる
            s.approvals.push(gateKey(s, g.name, g.phase))
            s.history.push({
                step: s.step,
                attempt: s.attempt,
                result: 'skipped',
                reason: `${g.name} を skip`,
                at: this.now().toISOString(),
            })
            if (!s.completed.includes(s.step!)) {
                s.completed.push(s.step!)
            }
            s.gate = null
            s.status = 'idle'
            await this.save(s)
            return
        }
        if (g.phase === 'adopt') {
            if (!g.workspace) {
                throw new OwnershipError('承認対象の worktree 情報がありません')
            }
            const current = (await this.a.workspace.list()).find((w) => sameWorkspace(w, g.workspace!))
            if (!current) {
                throw new OwnershipError('承認対象の worktree が移動・変更されています。再確認してください')
            }
            await this.owned.addWorkspace(current, { issue: s.issue, step: s.step! }, 'adopted')
            s.gate = null
            s.status = 'idle'
            await this.save(s)
            return
        }
        if (g.phase === 'question') {
            throw new Error('agent の質問にはペインで回答してください。次の tick が作業再開を検出します')
        }
        if (g.phase === 'recovery') {
            if (!['applied', 'retry'].includes(choice ?? '')) {
                throw new Error('実行済みか確認して --choice applied|retry を指定してください')
            }
            if (g.name === 'launch_recovery') {
                if (choice === 'applied') {
                    const owned = (await this.owned.read()).agents.find(
                        (a) => a.name === s.agent?.name && a.issue === s.issue && a.step === s.step
                    )
                    if (!owned) {
                        throw new OwnershipError('起動した agent の所有記録がありません')
                    }
                    s.agent = {
                        runner: owned.runner,
                        name: owned.name,
                        paneId: owned.paneId,
                        sessionId: owned.sessionId,
                        keepTab: owned.keepTab,
                    }
                }
                s.launchPending = false
                s.gate = null
                s.status = choice === 'applied' ? 'running' : 'idle'
                if (choice === 'retry') {
                    s.attempt = Math.max(0, s.attempt - 1)
                }
                await this.save(s)
                return
            }
            if (s.baseChange?.retarget && s.inflight?.key.startsWith('base-retarget:')) {
                if (choice === 'applied') {
                    s.effects.push(s.inflight.key)
                    delete s.inflight
                    await this.resumeBase(s, true)
                } else {
                    delete s.inflight
                    s.gate = null
                    await this.gate(
                        s,
                        'base_changed',
                        'base',
                        'retarget の再実行を承認してください。--choice keep|retarget'
                    )
                }
                return
            }
            const operation = s.inflight
            if (choice === 'applied' && operation) {
                s.effects.push(operation.key)
            }
            delete s.inflight
            s.gate = null
            if (operation?.key.endsWith(':request')) {
                s.status = choice === 'applied' ? 'waiting_remote' : 'idle'
                s.remoteRetry = choice === 'retry'
                if (choice === 'retry') {
                    s.attempt = Math.max(0, s.attempt - 1)
                }
            } else if (operation?.key.endsWith(':initial-prompt')) {
                if (choice === 'applied') {
                    delete s.initialPrompt
                }
                s.status = 'running'
            } else if (operation?.key.endsWith(':result-reminder')) {
                s.resultReminder = choice === 'applied'
                s.status = 'running'
            } else if (s.dbReset && operation?.key.startsWith(`${s.dbReset.key}:`)) {
                // Re-enter the reset state machine; never dispatch a second agent or repeat a receipt.
                s.status = 'running'
            } else if (s.continuation) {
                if (choice === 'retry' && operation) {
                    await this.continueAgent(s, operation.command)
                } else {
                    s.status = 'running'
                }
            } else if (s.pendingResult) {
                s.status = 'idle'
                if (s.approvedGate?.phase === 'ng') {
                    await this.applyNgAction(s, s.approvedGate.decision)
                } else {
                    await this.applyResult(s, step!)
                }
            } else {
                s.status = 'idle'
            }
            await this.save(s)
            return
        }
        if (g.name === 'ng_action' && choice === 'copilot') {
            if (!this.workflow.remote?.ng_action) {
                throw new Error('remote.ng_action を設定してください')
            }
            const prs = (await this.a.tracker.findPullRequests(s.issue)).filter((p) => p.state === 'open')
            if (prs.length !== 1) {
                throw new Error('open PR が1件必要')
            }
            if (!(await exists(FlowPaths.comment(await this.a.stages.dir(s.issue))))) {
                throw new Error('ng-comment.md がありません')
            }
        }
        if (g.phase === 'after' || g.phase === 'ng') {
            s.approvedGate = { ...g, decision: choice }
        }
        s.approvals.push(gateKey(s, g.name, g.phase))
        s.gate = null
        s.status = 'idle'
        await this.save(s)
        if (g.phase === 'db') {
            s.status = g.resume ?? 'running'
            await this.save(s)
            return
        }
        if (g.name === 'ng_action') {
            await this.applyNgAction(s, choice)
            return
        }
        if (g.phase === 'after') {
            await this.applyResult(s, step!)
        }
    }
    async applyNgAction(s: State, choice?: string): Promise<void> {
        if (!['copilot', 'self', 'stop'].includes(choice ?? '')) {
            throw new Error('ng_action の choice が必要です')
        }
        if (choice === 'copilot') {
            const config = this.workflow.remote?.ng_action
            if (!config) {
                throw new Error('remote.ng_action を設定してください')
            }
            const prs = (await this.a.tracker.findPullRequests(s.issue)).filter((p) => p.state === 'open')
            if (prs.length !== 1) {
                throw new Error('open PR が1件必要')
            }
            const ctx = await this.context(s, undefined, prs[0])
            if (!(await exists(FlowPaths.comment(String(ctx.issue_dir))))) {
                throw new Error('ng-comment.md がありません')
            }
            if (!s.effects.includes(`${s.step}:${s.attempt}:ng-comment`)) {
                s.remoteSince = this.now().toISOString()
            }
            await this.save(s)
            if (!(await this.command(s, config.command, `${s.step}:${s.attempt}:ng-comment`, ctx))) {
                return
            }
            await this.closeCompleted(s)
            await this.a.stages.set(s.issue, config.set_stage)
            s.status = 'waiting_remote'
            const remoteStep = Object.entries(this.workflow.steps).find(([, step]) => step.remote)
            if (!remoteStep) {
                throw new Error('remote step がありません')
            }
            s.startedAt = s.remoteSince ?? this.now().toISOString()
            s.step = remoteStep[0]
            s.completed = s.completed.filter(
                (n) =>
                    ![
                        remoteStep[0],
                        ...Object.keys(this.workflow.steps).filter(
                            (n) => this.workflow.steps[n]?.on_ng?.gate === 'ng_action'
                        ),
                    ].includes(n)
            )
            delete s.pendingResult
        } else {
            await this.closeCompleted(s)
            s.status = 'stopped'
        }
        delete s.approvedGate
        await this.save(s)
    }
    async acquireResource(resource: string, issue: number): Promise<boolean> {
        this.locks.validate(resource)
        return mutex(
            this.paths.tickPid,
            async () => {
                const state = await this.states.read(issue)
                if (resource === 'db:exclusive' && this.workflow.gates.db_reset !== 'auto') {
                    if (!state) {
                        throw new Error('DB gate の state がありません')
                    }
                    if (!state.approvals.includes(gateKey(state, 'db_reset', 'db'))) {
                        if (!state.gate) {
                            const resume = state.status
                            await this.gate(state, 'db_reset', 'db', `${resource} を取得し DB をリセットしてよいか確認`)
                            state.gate!.resume = resume
                            await this.save(state)
                        }
                        return false
                    }
                }
                const result = await this.locks.acquire(
                    [resource],
                    issue,
                    resource.startsWith('slot:') ? await this.a.workspace.list() : []
                )
                if (result && state) {
                    if (resource === 'db:exclusive') {
                        state.approvals = state.approvals.filter((k) => k !== gateKey(state, 'db_reset', 'db'))
                    }
                    state.locks = (await this.locks.list()).holders
                        .filter((h) => h.issue === issue)
                        .map((h) => h.resource)
                    await this.save(state)
                }
                return !!result
            },
            true
        )
    }
    async releaseResource(resource: string, issue: number): Promise<void> {
        this.locks.validate(resource)
        await mutex(
            this.paths.tickPid,
            async () => {
                await this.locks.release(issue, resource)
                const state = await this.states.read(issue)
                if (state) {
                    state.locks = (await this.locks.list()).holders
                        .filter((h) => h.issue === issue)
                        .map((h) => h.resource)
                    await this.save(state)
                }
            },
            true
        )
    }
    async answer(issue: number, text: string): Promise<void> {
        await mutex(
            this.paths.tickPid,
            async () => {
                const s = await this.states.read(issue)
                if (
                    !s ||
                    s.status !== 'waiting_gate' ||
                    s.gate?.name !== 'agent_question' ||
                    s.gate.phase !== 'question'
                ) {
                    throw new Error('agent の質問待ちではありません')
                }
                if (!s.agent) {
                    throw new Error('回答先の agent がありません')
                }
                await this.promptOwned(s.agent, text)
                // Delivery is confirmed, so resume now rather than wait for a tick to see the agent working.
                s.status = 'running'
                s.gate = null
                s.lastActivityAt = this.now().toISOString()
                await this.save(s)
                await this.events.add(issue, s.step, 'answer', text.slice(0, 200))
            },
            true
        )
    }
    async open(issue: number): Promise<void> {
        const s = await this.states.read(issue)
        let tabId: string | undefined
        if (s?.agent) {
            const owned = await this.owned.agent(s.agent)
            if (!owned) {
                throw new Error('agent の所有記録がありません')
            }
            tabId = owned.tabId ?? s.agent.tabId
        } else {
            tabId = (await this.owned.tab(issue))?.tabId
        }
        if (!tabId) {
            throw new Error('Issue の agent またはタブがありません')
        }
        await this.a.runner.focusTab(tabId)
    }
    async control(
        issue: number,
        action: 'approve' | 'reject' | 'retry' | 'stop',
        options: { gate?: string; choice?: string; reason?: string } = {}
    ): Promise<void> {
        await mutex(this.paths.tickPid, async () => {
            try {
                this.a.stages.beginTick?.()
                const stage = action === 'reject' ? await this.a.stages.get(issue) : undefined
                let s = action === 'reject' && stage === null ? null : await this.states.read(issue)
                if (!s && action === 'reject') {
                    // A dry-run does not persist state. Recheck the current stage/configuration;
                    // never treat an old last-plan.json as approval to reject a different gate.
                    if (!(await this.a.tracker.getIssue(issue))) {
                        throw new Error('Issue がありません')
                    }
                    s = initialState(issue, this.now().toISOString())
                    const selected = await this.select(s)
                    const gate = selected?.[1].gate_before
                    if (options.gate && (!selected || !gate || this.workflow.gates[gate] !== 'manual')) {
                        throw new Error('該当する開始 gate がありません')
                    }
                    s.step = selected?.[0] ?? null
                    if (gate && this.workflow.gates[gate] === 'manual') {
                        s.status = 'waiting_gate'
                        s.gate = makeGate(gate, 'before', `${s.step} の開始承認`, [], this.now().toISOString())
                    }
                }
                if (!s) {
                    throw new Error('state.json がありません')
                }
                if (action !== 'approve' && s.dbReset && s.inflight?.key.startsWith(`${s.dbReset.key}:`)) {
                    throw new Error(
                        'DB リセットまたは再開指示の結果が不明です。先に operation_recovery で実行状況を確認してください'
                    )
                }
                if (action === 'approve') {
                    await this.approveState(s, options.gate, options.choice)
                    await this.events.add(
                        issue,
                        s.step,
                        'approve',
                        `${options.gate ?? 'current'} ${options.choice ?? ''}`
                    )
                    return
                }
                if (action === 'reject' && options.gate && (!s.gate || s.gate.name !== options.gate)) {
                    throw new Error('該当する gate がありません')
                }
                if (action === 'retry') {
                    if (!['stopped', 'failed', 'retry_wait'].includes(s.status)) {
                        throw new Error('retry は stopped/failed/retry_wait だけに使えます')
                    }
                    if (await this.busy(s)) {
                        throw new Error('agent がまだ動いています。ペインで確認してください')
                    }
                    if (s.retainResources) {
                        await this.release(s)
                    }
                    const from = s.rejectedFromStage ?? s.heldFromStage
                    if (from) {
                        await this.a.stages.ensure(issue)
                        await this.a.stages.set(issue, from)
                        delete s.rejectedFromStage
                        delete s.heldFromStage
                    }
                    s.attempt = 0
                    s.startedAt = null
                    s.status = 'idle'
                    s.completed = s.completed.filter((x) => x !== s.step)
                    // effects の key は `<step>:<attempt>:...`。attempt を 0 に戻すと前回の試行と key が衝突し、
                    // 初回プロンプトなどが「送信済み」と見なされて飛ばされる。step の実行済み記録も一緒に戻す。
                    if (s.step) {
                        const prefix = `${s.step}:`
                        s.effects = s.effects.filter((x) => !x.startsWith(prefix))
                        s.resultReminder = false
                    }
                    s.nextRetryAt = null
                    s.approvals = []
                    delete s.dbReset
                    delete s.pendingResult
                    delete s.continuation
                    delete s.approvedGate
                    delete s.launchPending
                    delete s.initialPrompt
                    if (!s.inflight) {
                        delete s.baseChange
                    }
                    delete s.baseAccepted
                    if (s.step && this.workflow.steps[s.step]?.remote) {
                        s.remoteRetry = true
                    }
                } else {
                    if (s.agent || s.worker) {
                        await this.stopAndClose(s)
                    }
                    if (action === 'reject') {
                        await this.closeIssueTab(s)
                        await this.a.stages.ensure(issue)
                        s.rejectedFromStage ??=
                            s.heldFromStage ?? (await this.a.stages.get(issue)) ?? this.workflow.stage_store.initial
                        delete s.heldFromStage
                        // Save the original stage before issue:mark moves the entire directory.
                        await this.save(s)
                        await this.a.stages.set(issue, this.workflow.stage_store.rejected)
                    }
                    await this.release(s)
                    delete s.dbReset
                    s.status = 'stopped'
                    s.history.push({
                        step: s.step,
                        attempt: s.attempt,
                        result: action,
                        reason: options.reason ?? '人による停止',
                        at: this.now().toISOString(),
                    })
                }
                s.gate = null
                await this.save(s)
                await this.events.add(issue, s.step, action, options.reason ?? action)
            } catch (e) {
                if (e instanceof CommandError) {
                    await this.events.add(issue, null, 'command_error', String(e), e.details)
                }
                throw e
            }
        })
    }
}
