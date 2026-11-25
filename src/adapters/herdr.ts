import { promises as fs } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import type { Ownership } from '../core/ownership.js'
import {
    IssueTabBusyError,
    type Owner,
    OwnershipError,
    sameWorkspace,
    WorkspaceBusyError,
    WorkspaceDirtyError,
} from '../core/ownership.js'
import { FlowPaths } from '../core/paths.js'
import { quote, render } from '../core/template.js'
import type {
    AgentHandle,
    AgentPlace,
    AgentStatus,
    Exec,
    Runner,
    RunnerAgent,
    Workflow,
    Workspace,
    WorkspaceInfo,
} from '../core/types.js'
import { promptView, terminalText } from './prompt-delivery.js'

export function pairs(output: string): Record<string, string> {
    const line = output.trim().split('\n').at(-1) ?? ''
    return Object.fromEntries([...line.matchAll(/(?:^|\s)(\w+)=(.*?)(?=\s\w+=|$)/g)].map((m) => [m[1]!, m[2]!]))
}
type Warn = (message: string) => void | Promise<void>
/** The worktree tab an agent runs in; `mise wt:agent` uses the same label. */
export const AGENT_TAB = 'agent'
export function parseWorkspaces(output: string, warn: (message: string) => void = console.warn): WorkspaceInfo[] {
    const rows: WorkspaceInfo[] = []
    for (const line of output
        .trim()
        .split('\n')
        .filter((x) => x && !x.startsWith('['))) {
        const [id, slot, branch, ...rest] = line.split('\t')
        const dir = rest.join('\t')
        if (!id || !slot || !branch || !path.isAbsolute(dir) || (slot !== '-' && !/^\d+$/.test(slot))) {
            warn(`worktree 一覧の行が不正なため無視: ${line}`)
            continue
        }
        rows.push({
            key: branch,
            path: dir,
            workspaceId: id === '-' ? null : id,
            branch,
            slot: slot === '-' ? null : Number(slot),
        })
    }
    return rows
}
export class HerdrWorkspace implements Workspace {
    constructor(
        readonly exec: Exec,
        readonly config: Workflow['workspace'],
        readonly vars: Workflow['vars'],
        readonly dryRun: boolean,
        readonly owned: Ownership,
        readonly warn: Warn = console.warn
    ) {}
    async command(
        name: keyof Workflow['workspace']['commands'],
        values: Record<string, unknown>,
        mutation = true
    ): Promise<string> {
        const source = this.config.commands[name]
        if (!source) {
            throw new Error(`workspace.commands.${name} が必要`)
        }
        return this.exec.run({
            command: render(source, { ...this.vars, ...values }, true),
            cwd: String(this.vars.main),
            mutation,
        })
    }
    async list(): Promise<WorkspaceInfo[]> {
        const warnings: string[] = []
        const rows = parseWorkspaces(await this.command('list', {}, false), (m) => warnings.push(m))
        for (const warning of warnings) {
            await this.warn(warning)
        }
        return rows
    }
    async ensure(spec: Parameters<Workspace['ensure']>[0]): Promise<WorkspaceInfo> {
        const existing = (await this.list()).find((ws) => ws.branch === spec.branch)
        if (existing) {
            await this.owned.assertWorkspace(existing)
            if (spec.existingOnly && (await this.owned.workspace(existing))?.issue !== spec.owner.issue) {
                throw new WorkspaceBusyError(`再利用する worktree の所有者が変わりました: ${spec.branch}`)
            }
            if (await this.owned.foreignBusy(existing, await readAgents(this.exec, String(this.vars.main)))) {
                throw new WorkspaceBusyError('人の agent が使用中の workspace です')
            }
            const previous = { ...existing }
            if (!existing.workspaceId) {
                const output = await this.exec.run({
                    command: `herdr worktree open --cwd ${quote(this.vars.main)} --branch ${quote(spec.branch)} --no-focus`,
                    cwd: String(this.vars.main),
                    mutation: true,
                })
                if (this.dryRun) {
                    existing.workspaceId = '<workspace>'
                } else {
                    const data = JSON.parse(output)
                    existing.workspaceId = data.result.workspace.workspace_id
                }
            }
            if (previous.workspaceId !== existing.workspaceId) {
                await this.owned.replaceWorkspace(previous, existing)
            }
            return { ...existing, key: spec.key, base: spec.base }
        }
        if (spec.existingOnly) {
            throw new WorkspaceBusyError(`再利用する worktree が見つかりません: ${spec.branch}`)
        }
        const output = await this.command(spec.base ? 'create_from_base' : 'create_for_branch', {
            ...spec,
            base: spec.base ?? '',
        })
        let dir: string
        let id: string | null
        if (this.dryRun) {
            dir = FlowPaths.forProject(String(this.vars.main)).virtualWorkspace(spec.key)
            id = '<workspace>'
        } else if (output.trim().startsWith('{')) {
            const data = JSON.parse(output).result
            dir = data.worktree.path
            id = data.workspace.workspace_id
        } else {
            const p = pairs(output)
            dir = p.worktree!
            id = p.workspace ?? null
        }
        if (!dir || !path.isAbsolute(dir) || !id) {
            throw new Error(`worktree 作成結果が不正: ${output}`)
        }
        let slot: number | null = null
        if (!this.dryRun) {
            const raw = await fs.readFile(FlowPaths.ports(dir), 'utf8').catch(() => '')
            const n = /^PORT_SLOT=(\d+)$/m.exec(raw)
            slot = n ? Number(n[1]) : null
        }
        const ws = {
            key: spec.key,
            path: dir,
            workspaceId: id,
            branch: spec.branch,
            slot,
            base: spec.base,
        }
        await this.owned.addWorkspace(ws, spec.owner, 'created')
        return ws
    }
    async assertCurrentWorkspace(ws: WorkspaceInfo): Promise<void> {
        await this.owned.assertWorkspace(ws)
        if (this.dryRun && ws.workspaceId === '<workspace>') {
            return
        }
        if (!(await this.list()).some((current) => sameWorkspace(current, ws))) {
            throw new OwnershipError(`worktree の所有記録と現在の workspace が一致しません: ${ws.path}`)
        }
    }
    async sync(ws: WorkspaceInfo): Promise<void> {
        await this.assertCurrentWorkspace(ws)
        if (await this.owned.foreignBusy(ws, await readAgents(this.exec, String(this.vars.main)))) {
            throw new WorkspaceBusyError('人の agent が使用中の workspace です')
        }
        if (ws.slot !== null && this.config.commands.assign_slot) {
            await this.command('assign_slot', { ...ws, path: ws.path, slot: ws.slot })
        }
        await this.command('sync', { ...ws, path: ws.path, workspace: ws.workspaceId })
    }
    async remove(ws: WorkspaceInfo): Promise<void> {
        await this.assertCurrentWorkspace(ws)
        if (await this.owned.foreignBusy(ws, await readAgents(this.exec, String(this.vars.main)))) {
            throw new WorkspaceBusyError('人の agent が使用中の workspace は削除できません')
        }
        // Refuse deletion if local work or unpushed commits exist. A missing upstream is not assumed safe.
        const changes = await this.exec.run({
            command: 'git status --porcelain',
            cwd: ws.path,
            mutation: false,
        })
        let ahead: string
        try {
            ahead = await this.exec.run({
                command: 'git log --oneline @{u}..HEAD',
                cwd: ws.path,
                mutation: false,
            })
        } catch (e) {
            if (!ws.base || !/no upstream|upstream.*not configured|unknown revision.*@\{u\}/i.test(String(e))) {
                throw e
            }
            ahead = await this.exec.run({
                command: `git log --oneline ${quote(ws.base)}..HEAD`,
                cwd: ws.path,
                mutation: false,
            })
        }
        if (changes.trim() || ahead.trim()) {
            throw new WorkspaceDirtyError(`未コミットまたは未 push の変更があるため削除できません: ${ws.path}`)
        }
        await this.command('remove', { ...ws, workspace: ws.workspaceId })
        await this.owned.removeWorkspace(ws)
    }
}
export type RawAgent = {
    name?: string
    pane_id: string
    agent_status: string
    interactive_ready?: boolean
    agent?: string
    workspace_id?: string
    cwd?: string
    agent_session?: { value?: string }
}
const normalizedAgent = (a: RawAgent): RunnerAgent => ({
    name: a.name,
    paneId: a.pane_id,
    workspaceId: a.workspace_id ?? null,
    cwd: a.cwd,
    status: ['working', 'blocked', 'idle', 'done'].includes(a.agent_status)
        ? (a.agent_status as AgentStatus)
        : 'working',
    sessionId: a.agent_session?.value,
})
async function readAgents(exec: Exec, main: string): Promise<RunnerAgent[]> {
    return parseAgents(await exec.run({ command: 'herdr agent list', cwd: main, mutation: false })).map(normalizedAgent)
}
export function parseAgents(output: string, warn: (message: string) => void = console.warn): RawAgent[] {
    const data = JSON.parse(output)
    if (!Array.isArray(data.result?.agents)) {
        throw new Error('herdr agent list の出力が不正')
    }
    return data.result.agents.filter((a: unknown) => {
        if (
            a &&
            typeof a === 'object' &&
            typeof (a as RawAgent).pane_id === 'string' &&
            (a as RawAgent).pane_id &&
            typeof (a as RawAgent).agent_status === 'string'
        ) {
            return true
        }
        warn(`agent 一覧の行が不正なため無視: ${JSON.stringify(a)}`)
        return false
    })
}
export class HerdrRunner implements Runner {
    constructor(
        readonly exec: Exec,
        readonly config: Workflow['runner'],
        readonly main: string,
        readonly dryRun: boolean,
        readonly owned: Ownership,
        readonly warn: Warn = console.warn,
        readonly delivery = { waitMs: 30_000, pollMs: 500, settleMs: 500 }
    ) {}
    async focusTab(tabId: string): Promise<void> {
        await this.exec.run({ command: `herdr tab focus ${quote(tabId)}`, cwd: this.main, mutation: true })
    }
    async agents(): Promise<RawAgent[]> {
        const warnings: string[] = []
        const agents = parseAgents(
            await this.exec.run({ command: 'herdr agent list', cwd: this.main, mutation: false }),
            (m) => warnings.push(m)
        )
        for (const warning of warnings) {
            await this.warn(warning)
        }
        return agents
    }
    async list(): Promise<RunnerAgent[]> {
        return (await this.agents()).map(normalizedAgent)
    }
    async current(h: AgentHandle): Promise<RawAgent | undefined> {
        await this.owned.assertAgent(h)
        const a = (await this.agents()).find((a) => a.name === h.name && a.pane_id === h.paneId)
        if (!a || !(await this.owned.liveAgent(normalizedAgent(a)))) {
            if (this.dryRun && h.paneId === '<pane>') {
                return undefined
            }
            throw new OwnershipError(`agent の所有記録と現在のペインが一致しません: ${h.name}`)
        }
        return a
    }
    async start(spec: {
        name: string
        ws: WorkspaceInfo
        kind: 'claude' | 'codex'
        owner: Owner
        place?: AgentPlace
        systemPromptFile?: string
    }): Promise<AgentHandle> {
        if (spec.ws.key === 'main' && !process.env.HERDR_PANE_ID) {
            throw new Error('workspace: none の起動には HERDR_PANE_ID が必要です。herdr の中で flow を実行してください')
        }
        if (!/^flow-[a-z0-9_-]{1,27}$/.test(spec.name)) {
            throw new Error(`agent 名が不正: ${spec.name}`)
        }
        if (spec.ws.path !== this.main || spec.ws.key !== 'main') {
            await this.owned.assertWorkspace(spec.ws)
            if (await this.owned.foreignBusy(spec.ws, await this.list())) {
                throw new WorkspaceBusyError('人の agent が使用中の workspace です')
            }
        }
        const existing = (await this.agents()).find((a) => a.name === spec.name)
        if (existing) {
            const record = await this.owned.liveAgent(normalizedAgent(existing))
            if (!record) {
                throw new OwnershipError(`同名の agent は flow の所有物ではありません: ${spec.name}`)
            }
            if (!['idle', 'done'].includes(existing.agent_status)) {
                throw new Error(`既存 agent がまだ作業中です: ${spec.name}`)
            }
            const handle = {
                runner: 'herdr',
                name: spec.name,
                paneId: existing.pane_id,
                tabId: record.tabId,
                sessionId: existing.agent_session?.value,
                ...(record.keepTab ? { keepTab: true } : {}),
            }
            return handle
        }
        const keepTab = true
        const { tabId, paneId } =
            spec.place === 'worktree' ? await this.worktreeTab(spec.ws) : await this.issueTab(spec.owner.issue)
        // Only claude takes a system prompt file; codex starts with the step prompt alone.
        const guard =
            spec.kind === 'claude' && spec.systemPromptFile
                ? ` --append-system-prompt-file ${quote(spec.systemPromptFile)}`
                : ''
        await this.exec.run({
            command: `herdr agent start ${quote(spec.name)} --kind ${quote(spec.kind)} --pane ${quote(paneId)} -- --add-dir ${quote(this.main)}${guard}`,
            cwd: this.main,
            mutation: true,
        })
        const live = this.dryRun
            ? undefined
            : (await this.agents()).find((a) => a.name === spec.name && a.pane_id === paneId)
        if (!this.dryRun && !live) {
            throw new OwnershipError('起動した agent を確認できないため所有記録を作りません')
        }
        const handle = {
            runner: 'herdr',
            name: spec.name,
            paneId,
            tabId,
            sessionId: live?.agent_session?.value,
            ...(keepTab ? { keepTab: true } : {}),
        }
        await this.owned.addAgent(handle, spec.owner, spec.ws)
        return handle
    }
    private async createTab(workspace: string, label: string, cwd: string): Promise<{ tabId: string; paneId: string }> {
        const output = await this.exec.run({
            command: `herdr tab create --workspace ${quote(workspace)} --label ${quote(label)} --cwd ${quote(cwd)} --no-focus`,
            cwd: this.main,
            mutation: true,
        })
        const created = this.dryRun ? undefined : JSON.parse(output).result
        const tabId: string = this.dryRun ? '<tab>' : created.tab?.tab_id
        const paneId: string = this.dryRun ? '<pane>' : created.root_pane?.pane_id
        if (!tabId || !paneId) {
            throw new Error(`タブの作成結果が不正: ${output}`)
        }
        return { tabId, paneId }
    }
    private async issueTab(issue: number): Promise<{ tabId: string; paneId: string }> {
        const record = await this.owned.tab(issue)
        if (record) {
            const tab = await this.getTab(record.tabId)
            if (tab && (tab.workspace_id !== record.workspaceId || tab.label !== `flow-${issue}`)) {
                await this.owned.removeTab(issue)
                await this.warn(
                    `Issue #${issue} のタブ ${record.tabId} は所有記録と一致しないため、記録を外して作り直します`
                )
            } else if (tab) {
                const panes = await this.tabPanes(record.workspaceId, record.tabId)
                if (panes.length !== 1 || panes[0]!.pane_id !== record.paneId) {
                    throw new IssueTabBusyError('Issue タブのペイン構成が作成時と一致しません')
                }
                if (panes[0]!.agent) {
                    throw new IssueTabBusyError(`Issue タブではすでに ${panes[0]!.agent} が動いています`)
                }
                return { tabId: record.tabId, paneId: record.paneId }
            }
        }
        const workspaceId = await this.mainWorkspaceId()
        const created = await this.createTab(workspaceId, `flow-${issue}`, this.main)
        await this.owned.addTab({ issue, workspaceId, ...created, createdAt: new Date().toISOString() })
        return created
    }
    private async getTab(tabId: string): Promise<{ workspace_id: string; label: string } | undefined> {
        try {
            return JSON.parse(
                await this.exec.run({ command: `herdr tab get ${quote(tabId)}`, cwd: this.main, mutation: false })
            ).result.tab
        } catch (e) {
            if (/not found|見つかりません|tab_not_found/i.test(String(e))) {
                return undefined
            }
            throw e
        }
    }
    private async tabPanes(workspaceId: string, tabId: string): Promise<{ pane_id: string; agent?: string }[]> {
        const result = JSON.parse(
            await this.exec.run({
                command: `herdr pane list --workspace ${quote(workspaceId)}`,
                cwd: this.main,
                mutation: false,
            })
        ).result
        return result.panes.filter((p: { tab_id: string }) => p.tab_id === tabId)
    }
    async closeIssueTab(issue: number): Promise<boolean> {
        const record = await this.owned.tab(issue)
        if (!record) {
            return true
        }
        const tab = await this.getTab(record.tabId)
        if (!tab) {
            await this.owned.removeTab(issue)
            return true
        }
        if (tab.workspace_id !== record.workspaceId || tab.label !== `flow-${issue}`) {
            throw new OwnershipError('タブの workspace またはラベルが所有記録と一致しません')
        }
        const panes = await this.tabPanes(record.workspaceId, record.tabId)
        if (!panes.some((pane) => pane.pane_id === record.paneId)) {
            throw new OwnershipError('タブのペインが所有記録と一致しません')
        }
        if (panes.length !== 1 || panes[0]!.agent || !(await this.onlyPaneOf(record.tabId, record.paneId))) {
            return false
        }
        await this.exec.run({ command: `herdr tab close ${quote(record.tabId)}`, cwd: this.main, mutation: true })
        await this.owned.removeTab(issue)
        return true
    }
    // Same tab as `mise wt:agent`: the "agent" tab, else the worktree's first tab renamed to it (unless that is dev).
    private async worktreeTab(ws: WorkspaceInfo): Promise<{ tabId: string; paneId: string }> {
        if (!ws.workspaceId) {
            throw new Error(`workspace の ID がありません: ${ws.path}`)
        }
        // A dry-run worktree does not exist yet, so there are no tabs to look up.
        if (this.dryRun && ws.workspaceId === '<workspace>') {
            return this.createTab(ws.workspaceId, AGENT_TAB, ws.path)
        }
        const tabs: { tab_id: string; label: string }[] = JSON.parse(
            await this.exec.run({
                command: `herdr tab list --workspace ${quote(ws.workspaceId)}`,
                cwd: this.main,
                mutation: false,
            })
        ).result.tabs
        let tab = tabs.find((t) => t.label === AGENT_TAB)
        if (!tab && tabs[0] && tabs[0].label !== 'dev') {
            tab = tabs[0]
            await this.exec.run({
                command: `herdr tab rename ${quote(tab.tab_id)} ${quote(AGENT_TAB)}`,
                cwd: this.main,
                mutation: true,
            })
        }
        if (!tab) {
            return this.createTab(ws.workspaceId, AGENT_TAB, ws.path)
        }
        const pane: { pane_id: string; agent?: string } | undefined = JSON.parse(
            await this.exec.run({
                command: `herdr pane list --workspace ${quote(ws.workspaceId)}`,
                cwd: this.main,
                mutation: false,
            })
        ).result.panes.find((p: { tab_id: string }) => p.tab_id === tab.tab_id)
        if (!pane) {
            throw new Error(`agent タブのペインが見つかりません: ${tab.tab_id}`)
        }
        if (pane.agent) {
            throw new WorkspaceBusyError(`worktree の agent タブではすでに ${pane.agent} が動いています`)
        }
        return { tabId: tab.tab_id, paneId: pane.pane_id }
    }
    async mainWorkspaceId(): Promise<string> {
        const workspaces = JSON.parse(
            await this.exec.run({ command: 'herdr workspace list', cwd: this.main, mutation: false })
        ).result.workspaces
        const main = workspaces.find(
            (w: { workspace_id: string; worktree?: { checkout_path: string } }) =>
                w.worktree?.checkout_path === this.main
        )
        if (!main) {
            throw new Error('メインの workspace が見つかりません')
        }
        return main.workspace_id
    }
    async ready(h: AgentHandle): Promise<'ready' | 'blocked' | 'pending' | 'gone'> {
        if (this.dryRun && h.paneId === '<pane>') {
            return 'ready'
        }
        // A bounded wait keeps one starting agent from holding the whole tick indefinitely.
        for (let n = 0; n < 21; n++) {
            const a = await this.current(h)
            if (!a) {
                return 'gone'
            }
            if (a.agent_status === 'blocked') {
                return 'blocked'
            }
            if (
                a.interactive_ready === true ||
                (a.interactive_ready === undefined && ['idle', 'done'].includes(a.agent_status))
            ) {
                // Readiness can precede the input UI by one frame. Recheck after settling.
                if (!this.dryRun) {
                    await sleep(this.delivery.settleMs)
                }
                const stable = await this.current(h)
                if (!stable) {
                    return 'gone'
                }
                if (stable.agent_status === 'blocked') {
                    return 'blocked'
                }
                if (
                    stable.interactive_ready === true ||
                    (stable.interactive_ready === undefined && ['idle', 'done'].includes(stable.agent_status))
                ) {
                    return 'ready'
                }
            }
            if (n < 20) {
                await sleep(250)
            }
        }
        return 'pending'
    }
    async close(h: AgentHandle): Promise<void> {
        await this.owned.assertAgent(h)
        // Verify the current session even when status() reports gone; a replaced pane is never closed.
        await this.current(h)
        const record = await this.owned.agent(h)
        const tabId = record?.tabId
        await this.stop(h)
        if (record?.keepTab) {
            await this.exit(h)
            await this.owned.removeAgent(h)
            return
        }
        // Ctrl+C may exit the agent. Ownership was checked immediately before stopping it.
        // A pane a human added to the flow tab keeps the tab open; only the agent pane closes.
        const command =
            tabId && (await this.onlyPaneOf(tabId, h.paneId!))
                ? `herdr tab close ${quote(tabId)}`
                : `herdr pane close ${quote(h.paneId)}`
        await this.exec.run({ command, cwd: this.main, mutation: true })
        await this.owned.removeAgent(h)
    }
    // The worktree's agent tab is shared with later steps and `mise wt:agent`, so only the agent quits.
    private async exit(h: AgentHandle): Promise<void> {
        if (this.dryRun && h.paneId === '<pane>') {
            await this.exec.run({
                command: `herdr agent prompt ${quote(h.name)} '/exit'`,
                cwd: this.main,
                mutation: true,
            })
            return
        }
        const deadline = Date.now() + this.delivery.waitMs
        let sent = false
        for (;;) {
            const status = await this.status(h)
            if (status === 'gone') {
                return
            }
            if (!sent && ['idle', 'done'].includes(status)) {
                // Ownership and session were checked by status() just before the keys are sent.
                await this.exec.run({
                    command: `herdr agent prompt ${quote(h.name)} '/exit'`,
                    cwd: this.main,
                    mutation: true,
                })
                sent = true
            }
            if (Date.now() >= deadline) {
                throw new Error(`agent が終了しません。agent のタブを確認してください: ${h.name}`)
            }
            await sleep(this.delivery.pollMs)
        }
    }
    private async onlyPaneOf(tabId: string, paneId: string): Promise<boolean> {
        if (this.dryRun && tabId === '<tab>') {
            return true
        }
        const tab = JSON.parse(
            await this.exec.run({ command: `herdr tab get ${quote(tabId)}`, cwd: this.main, mutation: false })
        ).result.tab
        const panes = JSON.parse(
            await this.exec.run({
                command: `herdr pane list --workspace ${quote(tab.workspace_id)}`,
                cwd: this.main,
                mutation: false,
            })
        ).result.panes.filter((p: { tab_id: string }) => p.tab_id === tabId)
        return panes.length === 1 && panes[0].pane_id === paneId
    }
    async status(h: AgentHandle): Promise<AgentStatus> {
        if (!(await this.owned.agent(h))) {
            return 'gone'
        }
        const a = (await this.agents()).find((x) => x.name === h.name && x.pane_id === h.paneId)
        if (a && !(await this.owned.liveAgent(normalizedAgent(a)))) {
            return 'gone'
        }
        if (!a) {
            return 'gone'
        }
        if (!['working', 'idle', 'blocked', 'done'].includes(a.agent_status)) {
            return 'working'
        }
        return a.agent_status as AgentStatus
    }
    private async visible(h: AgentHandle): Promise<string> {
        await this.current(h)
        return terminalText(
            await this.exec.run({
                command: `herdr agent read ${quote(h.name)} --source visible --lines 120`,
                cwd: this.main,
                mutation: false,
            })
        )
    }
    private async deliveryObservation(h: AgentHandle, text: string, baseline: string) {
        const agent = await this.current(h)
        if (!agent) {
            throw new Error('プロンプトの到達確認中に agent が見つかりません')
        }
        if (agent.agent_status === 'blocked') {
            throw new Error('プロンプトの到達確認中に agent が blocked になりました')
        }
        const view = promptView(await this.visible(h), text)
        return {
            status: agent.agent_status,
            ...view,
            received:
                agent.agent_status === 'working' ||
                (['idle', 'done'].includes(agent.agent_status) &&
                    !view.pending &&
                    !!view.output &&
                    view.output !== baseline),
        }
    }
    private async waitForDelivery(h: AgentHandle, text: string, baseline: string) {
        const deadline = Date.now() + this.delivery.waitMs
        for (;;) {
            const observation = await this.deliveryObservation(h, text, baseline)
            if (observation.received || Date.now() >= deadline) {
                return observation
            }
            await sleep(Math.min(this.delivery.pollMs, Math.max(0, deadline - Date.now())))
        }
    }
    async prompt(h: AgentHandle, text: string): Promise<void> {
        const before = await this.current(h)
        if (!this.dryRun && (!before || !['idle', 'done'].includes(before.agent_status))) {
            throw new Error('プロンプト送信前の agent が idle / done ではありません。再送せず確認してください')
        }
        const baseline = this.dryRun ? '' : promptView(await this.visible(h), text).output
        await this.exec.run({
            command: `herdr agent prompt ${quote(h.name)} ${quote(text)}`,
            cwd: this.main,
            mutation: true,
        })
        // dry-run records a plan; it cannot observe activity caused by skipped input.
        if (this.dryRun) {
            return
        }
        let observed = await this.waitForDelivery(h, text, baseline)
        if (observed.received) {
            return
        }
        // Take fresh evidence immediately before the sole Enter attempt. Ownership and
        // session identity are checked for every read and again before writing keys.
        observed = await this.deliveryObservation(h, text, baseline)
        if (observed.received) {
            return
        }
        if (!['idle', 'done'].includes(observed.status) || !observed.pending) {
            throw new Error('プロンプトの到達を確認できず、入力欄にも同じ本文を確認できません。再送しません')
        }
        const current = await this.current(h)
        if (current?.agent_status === 'working') {
            return
        }
        if (!current || !['idle', 'done'].includes(current.agent_status)) {
            throw new Error('Enter の直前に agent の状態が変わりました。再送しません')
        }
        await this.exec.run({
            command: `herdr agent send-keys ${quote(h.name)} enter`,
            cwd: this.main,
            mutation: true,
        })
        if (!(await this.waitForDelivery(h, text, baseline)).received) {
            throw new Error('Enter を1回送りましたがプロンプトの到達を確認できません。追加送信しません')
        }
    }
    async tail(h: AgentHandle, lines: number): Promise<string> {
        const agent = await this.current(h)
        // recent-unwrapped may scroll application history and rejects working agents.
        const source = ['idle', 'done'].includes(agent?.agent_status ?? '') ? 'recent-unwrapped' : 'visible'
        return terminalText(
            await this.exec.run({
                command: `herdr agent read ${quote(h.name)} --source ${source} --lines ${lines}`,
                cwd: this.main,
                mutation: false,
            })
        )
    }
    async stop(h: AgentHandle): Promise<void> {
        await this.owned.assertAgent(h)
        if ((await this.status(h)) === 'gone') {
            return
        }
        await this.current(h)
        if ((await this.status(h)) !== 'gone') {
            await this.exec.run({
                command: `herdr agent send-keys ${quote(h.name)} ctrl+c`,
                cwd: this.main,
                mutation: true,
            })
        }
    }
}
