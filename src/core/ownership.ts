import path from 'node:path'

import { atomic, exists, json, mutex } from './files.js'
import { FlowPaths } from './paths.js'
import type { AgentHandle, RunnerAgent, WorkspaceInfo } from './types.js'

export type Owner = { issue: number; step: string }
export type OwnedWorkspace = WorkspaceInfo & Owner & { createdAt: string; source: 'created' | 'adopted' }
export type OwnedAgent = AgentHandle & Owner & { paneId: string; createdAt: string; workspacePath: string }
export type OwnedTab = { issue: number; workspaceId: string; tabId: string; paneId: string; createdAt: string }
export type OwnershipRegistry = {
    version: 1
    workspaces: OwnedWorkspace[]
    agents: OwnedAgent[]
    tabs: OwnedTab[]
}
export class OwnershipError extends Error {}
export class WorkspaceBusyError extends Error {}
export class IssueTabBusyError extends WorkspaceBusyError {}
export class WorkspaceDirtyError extends Error {}
export const sameWorkspace = (a: WorkspaceInfo, b: WorkspaceInfo): boolean =>
    path.resolve(a.path) === path.resolve(b.path) && a.branch === b.branch && a.workspaceId === b.workspaceId

export class Ownership {
    readonly file: string
    private shadow?: OwnershipRegistry
    constructor(
        readonly rootDir: string,
        readonly dryRun = false
    ) {
        this.file = new FlowPaths(rootDir).owned
    }
    async read(): Promise<OwnershipRegistry> {
        if (this.shadow) {
            return this.shadow
        }
        const r = await json<OwnershipRegistry>(this.file)
        if (r === null && !(await exists(this.file))) {
            return { version: 1, workspaces: [], agents: [], tabs: [] }
        }
        if (
            !r ||
            r.version !== 1 ||
            !Array.isArray(r.workspaces) ||
            !Array.isArray(r.agents) ||
            !r.workspaces.every(
                (w) =>
                    typeof w.path === 'string' &&
                    path.isAbsolute(w.path) &&
                    typeof w.branch === 'string' &&
                    (typeof w.workspaceId === 'string' || w.workspaceId === null) &&
                    Number.isSafeInteger(w.issue) &&
                    w.issue > 0 &&
                    typeof w.step === 'string' &&
                    typeof w.createdAt === 'string'
            ) ||
            !r.agents.every(
                (a) =>
                    typeof a.name === 'string' &&
                    a.name.startsWith('flow-') &&
                    typeof a.paneId === 'string' &&
                    !!a.paneId &&
                    (a.tabId === undefined || (typeof a.tabId === 'string' && !!a.tabId)) &&
                    (a.keepTab === undefined || typeof a.keepTab === 'boolean') &&
                    Number.isSafeInteger(a.issue) &&
                    a.issue > 0 &&
                    typeof a.step === 'string' &&
                    typeof a.createdAt === 'string'
            )
        ) {
            throw new OwnershipError('owned.json が壊れています。所有者を推測して初期化しません')
        }
        // Discard legacy tab records that lack the current identity fields.
        r.tabs = Array.isArray(r.tabs)
            ? r.tabs.filter(
                  (t) =>
                      t &&
                      Number.isSafeInteger(t.issue) &&
                      t.issue > 0 &&
                      typeof t.workspaceId === 'string' &&
                      !!t.workspaceId &&
                      typeof t.tabId === 'string' &&
                      !!t.tabId &&
                      typeof t.paneId === 'string' &&
                      !!t.paneId &&
                      typeof t.createdAt === 'string'
              )
            : []
        return r
    }
    async change(fn: (r: OwnershipRegistry) => void): Promise<void> {
        if (this.dryRun) {
            this.shadow ??= structuredClone(await this.read())
            fn(this.shadow)
            return
        }
        await mutex(
            new FlowPaths(this.rootDir).ownedPid,
            async () => {
                const r = await this.read()
                fn(r)
                await atomic(this.file, r)
            },
            true
        )
    }
    async tab(issue: number): Promise<OwnedTab | undefined> {
        return (await this.read()).tabs.find((t) => t.issue === issue)
    }
    async addTab(tab: OwnedTab): Promise<void> {
        await this.change((r) => {
            r.tabs = r.tabs.filter((t) => t.issue !== tab.issue)
            r.tabs.push(tab)
        })
    }
    async removeTab(issue: number): Promise<void> {
        await this.change((r) => {
            r.tabs = r.tabs.filter((t) => t.issue !== issue)
        })
    }
    async workspace(ws: WorkspaceInfo): Promise<OwnedWorkspace | undefined> {
        return (await this.read()).workspaces.find((w) => sameWorkspace(w, ws))
    }
    async assertWorkspace(ws: WorkspaceInfo): Promise<void> {
        if (!(await this.workspace(ws))) {
            throw new OwnershipError(`所有記録のない worktree は操作できません: ${ws.path}`)
        }
    }
    async addWorkspace(ws: WorkspaceInfo, owner: Owner, source: OwnedWorkspace['source']): Promise<void> {
        await this.change((r) => {
            const existing = r.workspaces.find((w) => path.resolve(w.path) === path.resolve(ws.path))
            if (existing && sameWorkspace(existing, ws)) {
                return
            }
            if (existing && source !== 'adopted') {
                throw new OwnershipError(`worktree の所有記録と現在の識別子が一致しません: ${ws.path}`)
            }
            r.workspaces = r.workspaces.filter((w) => path.resolve(w.path) !== path.resolve(ws.path))
            r.workspaces.push({
                ...structuredClone(ws),
                ...owner,
                source,
                createdAt: new Date().toISOString(),
            })
        })
    }
    async replaceWorkspace(previous: WorkspaceInfo, next: WorkspaceInfo): Promise<void> {
        await this.change((r) => {
            const w = r.workspaces.find((w) => sameWorkspace(w, previous))
            if (!w) {
                throw new OwnershipError('worktree の所有記録がありません')
            }
            Object.assign(w, next)
        })
    }
    async removeWorkspace(ws: WorkspaceInfo): Promise<void> {
        await this.change((r) => {
            r.workspaces = r.workspaces.filter((w) => !sameWorkspace(w, ws))
        })
    }
    async agent(h: AgentHandle): Promise<OwnedAgent | undefined> {
        return (await this.read()).agents.find(
            (a) =>
                a.name === h.name &&
                a.paneId === h.paneId &&
                (!a.sessionId || !h.sessionId || a.sessionId === h.sessionId)
        )
    }
    async liveAgent(a: RunnerAgent): Promise<OwnedAgent | undefined> {
        if (!a.name) {
            return undefined
        }
        return (await this.read()).agents.find(
            (record) =>
                record.name === a.name &&
                record.paneId === a.paneId &&
                (!record.sessionId || record.sessionId === a.sessionId)
        )
    }
    async assertAgent(h: AgentHandle): Promise<void> {
        if (!h.name.startsWith('flow-') || !(await this.agent(h))) {
            throw new OwnershipError(`所有記録のない agent には指示・停止できません: ${h.name}`)
        }
    }
    async addAgent(h: AgentHandle, owner: Owner, ws: WorkspaceInfo): Promise<void> {
        if (!/^flow-[a-z0-9_-]+$/.test(h.name) || !h.paneId) {
            throw new OwnershipError('flow agent の名前・paneId が不正です')
        }
        await this.change((r) => {
            r.agents = r.agents.filter((a) => a.name !== h.name)
            r.agents.push({
                ...h,
                paneId: h.paneId!,
                ...owner,
                workspacePath: ws.path,
                createdAt: new Date().toISOString(),
            })
        })
    }
    async removeAgent(h: AgentHandle): Promise<void> {
        await this.assertAgent(h)
        await this.change((r) => {
            r.agents = r.agents.filter((a) => a.name !== h.name || a.paneId !== h.paneId)
        })
    }
    async foreignBusy(ws: WorkspaceInfo, agents: RunnerAgent[]): Promise<boolean> {
        for (const agent of agents) {
            if (
                ['working', 'blocked'].includes(agent.status) &&
                ((ws.workspaceId !== null && agent.workspaceId === ws.workspaceId) || agent.cwd === ws.path) &&
                !(await this.liveAgent(agent))
            ) {
                return true
            }
        }
        return false
    }
}
