import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { HerdrRunner, HerdrWorkspace, type RawAgent } from '../../src/adapters/herdr.js'
import { Ownership, OwnershipError, WorkspaceBusyError } from '../../src/core/ownership.js'
import type { ExecRequest } from '../../src/core/types.js'
import { config, temp } from '../helpers.js'

const dirs: string[] = []
afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    for (const d of dirs.splice(0)) {
        await fs.rm(d, { recursive: true, force: true })
    }
})
async function setup() {
    const dir = await temp()
    dirs.push(dir)
    const w = await config()
    w.vars.main = dir
    const owner = { issue: 1, step: 'refine' }
    const owned = new Ownership(dir)
    const ws = { key: 'main', path: dir, workspaceId: null, branch: '', slot: null }
    let live: RawAgent[] = []
    let tabs = 0
    let extra: { pane_id: string; tab_id: string }[] = []
    const exec = {
        run: vi.fn(async (r: ExecRequest) => {
            if (r.command === 'herdr agent list') {
                return JSON.stringify({ result: { agents: live } })
            }
            if (r.command === 'herdr workspace list') {
                return JSON.stringify({
                    result: {
                        workspaces: [
                            { workspace_id: 'worktree', worktree: { checkout_path: '/other' } },
                            { workspace_id: 'main', worktree: { checkout_path: dir } },
                        ],
                    },
                })
            }
            if (r.command.startsWith('herdr tab create')) {
                const n = tabs++
                return JSON.stringify({
                    result: { tab: { tab_id: `owned-tab-${n}` }, root_pane: { pane_id: `owned-agent-${n}` } },
                })
            }
            if (r.command.startsWith('herdr tab get')) {
                const id = /get '([^']+)'/.exec(r.command)![1]!
                return JSON.stringify({
                    result: {
                        tab: { tab_id: id, workspace_id: 'main', label: `flow-${Number(id.split('-').at(-1)) + 1}` },
                    },
                })
            }
            if (r.command.startsWith('herdr pane list')) {
                return JSON.stringify({
                    result: {
                        panes: [
                            { pane_id: 'run-pane', tab_id: 'human-tab', agent: 'codex' },
                            ...Array.from({ length: tabs }, (_, n) => ({
                                pane_id: `owned-agent-${n}`,
                                tab_id: `owned-tab-${n}`,
                            })),
                            ...extra,
                        ],
                    },
                })
            }
            if (r.command.startsWith('herdr agent prompt') && r.command.endsWith("'/exit'")) {
                live = []
            }
            if (r.command.startsWith('herdr agent start')) {
                const name = /start '([^']+)'/.exec(r.command)![1]!
                const pane = /--pane '([^']+)'/.exec(r.command)![1]!
                live.push({
                    name,
                    pane_id: pane,
                    agent_status: 'idle',
                    agent_session: { value: `session-${live.length}` },
                })
            }
            return ''
        }),
    }
    const runner = new HerdrRunner(exec, w.runner, dir, false, owned)
    return {
        dir,
        w,
        owner,
        owned,
        ws,
        exec,
        runner,
        setLive: (a: RawAgent[]) => {
            live = a
        },
        addPane: (pane: { pane_id: string; tab_id: string }) => {
            extra.push(pane)
        },
    }
}
describe('main checkout agent pane', () => {
    it('appends the guard as a system prompt file for claude only', async () => {
        const h = await setup()
        vi.stubEnv('HERDR_PANE_ID', 'run-pane')
        const guard = path.join(h.dir, 'run/guard/flow-refine-1.md')
        await h.runner.start({
            name: 'flow-refine-1',
            ws: h.ws,
            kind: 'claude',
            owner: h.owner,
            systemPromptFile: guard,
        })
        await new HerdrRunner(h.exec, h.w.runner, h.dir, false, h.owned).start({
            name: 'flow-refine-2',
            ws: h.ws,
            kind: 'codex',
            owner: { issue: 2, step: 'refine' },
            systemPromptFile: guard,
        })
        expect(h.exec.run.mock.calls.map(([r]) => r.command).filter((c) => c.startsWith('herdr agent start'))).toEqual([
            `herdr agent start 'flow-refine-1' --kind 'claude' --pane 'owned-agent-0' -- --add-dir '${h.dir}' --append-system-prompt-file '${guard}'`,
            `herdr agent start 'flow-refine-2' --kind 'codex' --pane 'owned-agent-1' -- --add-dir '${h.dir}'`,
        ])
    })
    it('fails clearly outside Herdr before creating any pane or starting an agent', async () => {
        const h = await setup()
        vi.stubEnv('HERDR_PANE_ID', undefined)
        await expect(
            h.runner.start({ name: 'flow-refine-1', ws: h.ws, kind: 'codex', owner: h.owner })
        ).rejects.toThrow('HERDR_PANE_ID')
        expect(h.exec.run).not.toHaveBeenCalled()
    })
    it('starts each agent in the root pane of its own flow-<issue> tab, never splitting a pane', async () => {
        const h = await setup()
        vi.stubEnv('HERDR_PANE_ID', 'run-pane')
        const first = await h.runner.start({ name: 'flow-refine-1', ws: h.ws, kind: 'codex', owner: h.owner })
        const second = new HerdrRunner(h.exec, h.w.runner, h.dir, false, h.owned)
        await second.start({ name: 'flow-refine-2', ws: h.ws, kind: 'claude', owner: { issue: 2, step: 'refine' } })
        const commands = h.exec.run.mock.calls.map(([r]) => r.command)
        expect(commands.filter((c) => c.startsWith('herdr tab create'))).toEqual([
            `herdr tab create --workspace 'main' --label 'flow-1' --cwd '${h.dir}' --no-focus`,
            `herdr tab create --workspace 'main' --label 'flow-2' --cwd '${h.dir}' --no-focus`,
        ])
        expect(commands.filter((c) => c.startsWith('herdr agent start'))).toEqual([
            `herdr agent start 'flow-refine-1' --kind 'codex' --pane 'owned-agent-0' -- --add-dir '${h.dir}'`,
            `herdr agent start 'flow-refine-2' --kind 'claude' --pane 'owned-agent-1' -- --add-dir '${h.dir}'`,
        ])
        expect(commands.some((c) => c.startsWith('herdr pane split'))).toBe(false)
        expect(commands.some((c) => c.startsWith('herdr agent prompt'))).toBe(false)
        expect(first.keepTab).toBe(true)
        expect((await h.owned.read()).agents.map((a) => [a.name, a.paneId, a.tabId])).toEqual([
            ['flow-refine-1', 'owned-agent-0', 'owned-tab-0'],
            ['flow-refine-2', 'owned-agent-1', 'owned-tab-1'],
        ])
    })
    it('replaces a legacy tab record without an issue with the issue tab record', async () => {
        const h = await setup()
        await fs.mkdir(path.dirname(h.owned.file), { recursive: true })
        await fs.writeFile(
            h.owned.file,
            JSON.stringify({
                version: 1,
                workspaces: [],
                agents: [],
                tabs: [{ workspaceId: 'w', tabId: 'w:t', paneId: 'w:p' }],
            })
        )
        vi.stubEnv('HERDR_PANE_ID', 'run-pane')
        await h.runner.start({ name: 'flow-refine-1', ws: h.ws, kind: 'codex', owner: h.owner })
        expect(JSON.parse(await fs.readFile(h.owned.file, 'utf8')).tabs).toMatchObject([
            { issue: 1, tabId: 'owned-tab-0' },
        ])
    })
})
describe('worktree agent placement', () => {
    const ws = { key: 'verify-1', path: '/wt/verify-1', workspaceId: 'worktree', branch: 'flow/verify-1', slot: null }
    const owner = { issue: 1, step: 'verify' }
    async function worktree(
        tabs: { tab_id: string; label: string }[],
        panes: { pane_id: string; tab_id: string; agent?: string }[]
    ) {
        const h = await setup()
        await h.owned.addWorkspace(ws, owner, 'created')
        const original = h.exec.run.getMockImplementation()!
        h.exec.run.mockImplementation(async (r) => {
            if (r.command === "herdr tab list --workspace 'worktree'") {
                return JSON.stringify({ result: { tabs } })
            }
            if (r.command === "herdr pane list --workspace 'worktree'") {
                return JSON.stringify({ result: { panes } })
            }
            return original(r)
        })
        return h
    }
    const mutations = (h: Awaited<ReturnType<typeof setup>>) =>
        h.exec.run.mock.calls.filter(([r]) => r.mutation).map(([r]) => r.command)
    it("starts the agent in the worktree's first tab, renamed to agent, and keeps the tab", async () => {
        const h = await worktree(
            [
                { tab_id: 'worktree:t1', label: '1' },
                { tab_id: 'worktree:t2', label: 'dev' },
            ],
            [
                { pane_id: 'worktree:p1', tab_id: 'worktree:t1' },
                { pane_id: 'worktree:p2', tab_id: 'worktree:t2' },
            ]
        )
        const handle = await h.runner.start({ name: 'flow-verify-1', ws, kind: 'claude', owner, place: 'worktree' })
        expect(mutations(h)).toEqual([
            "herdr tab rename 'worktree:t1' 'agent'",
            `herdr agent start 'flow-verify-1' --kind 'claude' --pane 'worktree:p1' -- --add-dir '${h.dir}'`,
        ])
        expect(handle).toMatchObject({ paneId: 'worktree:p1', tabId: 'worktree:t1', keepTab: true })
        expect((await h.owned.agent(handle))?.keepTab).toBe(true)
    })
    it('reuses an existing agent tab, and creates one rather than taking a first dev tab', async () => {
        const reuse = await worktree(
            [
                { tab_id: 'worktree:t1', label: 'dev' },
                { tab_id: 'worktree:t2', label: 'agent' },
            ],
            [{ pane_id: 'worktree:p2', tab_id: 'worktree:t2' }]
        )
        await reuse.runner.start({ name: 'flow-verify-1', ws, kind: 'claude', owner, place: 'worktree' })
        expect(mutations(reuse)).toEqual([
            `herdr agent start 'flow-verify-1' --kind 'claude' --pane 'worktree:p2' -- --add-dir '${reuse.dir}'`,
        ])
        const dev = await worktree([{ tab_id: 'worktree:t1', label: 'dev' }], [])
        await dev.runner.start({ name: 'flow-verify-1', ws, kind: 'claude', owner, place: 'worktree' })
        expect(mutations(dev)[0]).toBe(
            "herdr tab create --workspace 'worktree' --label 'agent' --cwd '/wt/verify-1' --no-focus"
        )
    })
    it('refuses an agent tab whose pane already runs an agent', async () => {
        const h = await worktree(
            [{ tab_id: 'worktree:t1', label: 'agent' }],
            [{ pane_id: 'worktree:p1', tab_id: 'worktree:t1', agent: 'claude' }]
        )
        await expect(
            h.runner.start({ name: 'flow-verify-1', ws, kind: 'claude', owner, place: 'worktree' })
        ).rejects.toThrow(WorkspaceBusyError)
        expect(mutations(h)).toEqual([])
    })
    it('closes the worktree agent with /exit and leaves the agent tab open', async () => {
        const h = await worktree(
            [{ tab_id: 'worktree:t1', label: '1' }],
            [{ pane_id: 'worktree:p1', tab_id: 'worktree:t1' }]
        )
        const handle = await h.runner.start({ name: 'flow-verify-1', ws, kind: 'claude', owner, place: 'worktree' })
        const original = h.exec.run.getMockImplementation()!
        h.exec.run.mockImplementation(async (r) => {
            // Claude quits on /exit, so the pane no longer reports an agent.
            if (r.command === "herdr agent prompt 'flow-verify-1' '/exit'") {
                h.setLive([])
            }
            return original(r)
        })
        h.exec.run.mockClear()
        await h.runner.close(handle)
        expect(mutations(h)).toEqual([
            "herdr agent send-keys 'flow-verify-1' ctrl+c",
            "herdr agent prompt 'flow-verify-1' '/exit'",
        ])
        expect((await h.owned.read()).agents).toEqual([])
    })
})
describe('readiness and close ownership', () => {
    async function agent() {
        const h = await setup()
        vi.stubEnv('HERDR_PANE_ID', 'run-pane')
        const handle = await h.runner.start({ name: 'flow-refine-1', ws: h.ws, kind: 'codex', owner: h.owner })
        return { ...h, handle }
    }
    it('waits past an explicit not-ready idle status before accepting interactive_ready', async () => {
        const h = await agent()
        let reads = 0
        const original = h.exec.run.getMockImplementation()!
        h.exec.run.mockImplementation(async (r) =>
            r.command === 'herdr agent list'
                ? JSON.stringify({
                      result: {
                          agents: [
                              {
                                  name: h.handle.name,
                                  pane_id: h.handle.paneId,
                                  agent_status: 'idle',
                                  interactive_ready: ++reads > 1,
                                  agent_session: { value: h.handle.sessionId },
                              },
                          ],
                      },
                  })
                : original(r)
        )
        expect(await h.runner.ready(h.handle)).toBe('ready')
        expect(reads).toBe(3) // Recheck readiness after the input UI settles.
        expect(h.exec.run.mock.calls.some(([r]) => r.command.startsWith('herdr agent prompt'))).toBe(false)
    })
    it('accepts interactive_ready during working, and reports blocked without sending anything', async () => {
        const h = await agent()
        const raw = {
            name: h.handle.name,
            pane_id: h.handle.paneId!,
            agent_status: 'working',
            interactive_ready: true,
            agent_session: { value: h.handle.sessionId },
        }
        h.setLive([raw])
        expect(await h.runner.ready(h.handle)).toBe('ready')
        h.setLive([{ ...raw, agent_status: 'blocked' }])
        expect(await h.runner.ready(h.handle)).toBe('blocked')
        expect(h.exec.run.mock.calls.some(([r]) => r.command.startsWith('herdr agent prompt'))).toBe(false)
    })
    it('exits the agent and keeps the issue tab', async () => {
        const h = await agent()
        h.exec.run.mockClear()
        await h.runner.close(h.handle)
        expect(h.exec.run.mock.calls.filter(([r]) => r.mutation).map(([r]) => r.command)).toEqual([
            "herdr agent send-keys 'flow-refine-1' ctrl+c",
            "herdr agent prompt 'flow-refine-1' '/exit'",
        ])
        expect((await h.owned.read()).agents).toHaveLength(0)
    })
    it('keeps a tab with a human pane during cleanup', async () => {
        const h = await agent()
        await h.runner.close(h.handle)
        h.addPane({ pane_id: 'human-pane', tab_id: 'owned-tab-0' })
        expect(await h.runner.closeIssueTab(1)).toBe(false)
        expect(await h.owned.tab(1)).toBeDefined()
    })
    it('reuses an issue tab after the previous agent exits', async () => {
        const h = await agent()
        await h.runner.close(h.handle)
        const next = await h.runner.start({ name: 'flow-next-1', ws: h.ws, kind: 'codex', owner: h.owner })
        expect(next.paneId).toBe(h.handle.paneId)
        expect(h.exec.run.mock.calls.filter(([r]) => r.command.startsWith('herdr tab create'))).toHaveLength(1)
        await h.runner.close(next)
        expect(await h.runner.closeIssueTab(1)).toBe(true)
        expect(await h.owned.tab(1)).toBeUndefined()
    })
    it('does not start an agent when the issue tab pane is occupied', async () => {
        const h = await agent()
        await h.runner.close(h.handle)
        const original = h.exec.run.getMockImplementation()!
        h.exec.run.mockImplementation(async (r) => {
            if (r.command.startsWith('herdr pane list')) {
                return JSON.stringify({
                    result: { panes: [{ pane_id: 'owned-agent-0', tab_id: 'owned-tab-0', agent: 'human-agent' }] },
                })
            }
            return original(r)
        })
        await expect(h.runner.start({ name: 'flow-next-1', ws: h.ws, kind: 'codex', owner: h.owner })).rejects.toThrow(
            WorkspaceBusyError
        )
    })
    it.each(['extra-first', 'replaced'])('refuses a changed pane layout: %s', async (layout) => {
        const h = await agent()
        await h.runner.close(h.handle)
        const original = h.exec.run.getMockImplementation()!
        h.exec.run.mockImplementation(async (r) => {
            if (r.command.startsWith('herdr pane list')) {
                return JSON.stringify({
                    result: {
                        panes: [
                            { pane_id: 'human-pane', tab_id: 'owned-tab-0' },
                            ...(layout === 'extra-first' ? [{ pane_id: 'owned-agent-0', tab_id: 'owned-tab-0' }] : []),
                        ],
                    },
                })
            }
            return original(r)
        })
        h.exec.run.mockClear()
        await expect(h.runner.start({ name: 'flow-next-1', ws: h.ws, kind: 'codex', owner: h.owner })).rejects.toThrow(
            WorkspaceBusyError
        )
        expect(
            h.exec.run.mock.calls.some(
                ([r]) => r.command.startsWith('herdr agent start') || r.command.startsWith('herdr tab create')
            )
        ).toBe(false)
        if (layout === 'replaced') {
            await expect(h.runner.closeIssueTab(1)).rejects.toThrow(OwnershipError)
        } else {
            expect(await h.runner.closeIssueTab(1)).toBe(false)
        }
    })
    it.each(['label', 'workspace'])('recreates a tab with a changed %s without touching the old tab', async (field) => {
        const h = await agent()
        await h.runner.close(h.handle)
        const original = h.exec.run.getMockImplementation()!
        h.exec.run.mockImplementation(async (r) => {
            if (r.command === "herdr tab get 'owned-tab-0'") {
                return JSON.stringify({
                    result: {
                        tab: {
                            tab_id: 'owned-tab-0',
                            workspace_id: field === 'workspace' ? 'other' : 'main',
                            label: field === 'label' ? 'human' : 'flow-1',
                        },
                    },
                })
            }
            return original(r)
        })
        h.exec.run.mockClear()
        await expect(h.runner.closeIssueTab(1)).rejects.toThrow(OwnershipError)
        const warn = vi.fn()
        const runner = new HerdrRunner(h.exec, h.w.runner, h.dir, false, h.owned, warn)
        const next = await runner.start({ name: 'flow-next-1', ws: h.ws, kind: 'codex', owner: h.owner })
        expect(next).toMatchObject({ tabId: 'owned-tab-1', paneId: 'owned-agent-1' })
        expect(await h.owned.tab(1)).toMatchObject({ tabId: 'owned-tab-1', paneId: 'owned-agent-1' })
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('owned-tab-0'))
        const commands = h.exec.run.mock.calls.map(([r]) => r.command)
        expect(commands.some((c) => c.startsWith('herdr tab close') || c.startsWith('herdr pane close'))).toBe(false)
        expect(commands.some((c) => c.startsWith('herdr pane list'))).toBe(false)
        expect(commands.filter((c) => c.startsWith('herdr agent start'))).toEqual([
            `herdr agent start 'flow-next-1' --kind 'codex' --pane 'owned-agent-1' -- --add-dir '${h.dir}'`,
        ])
    })
    it('discards a legacy tab record without a pane ID', async () => {
        const h = await setup()
        vi.stubEnv('HERDR_PANE_ID', 'run-pane')
        await fs.mkdir(path.dirname(h.owned.file), { recursive: true })
        await fs.writeFile(
            h.owned.file,
            JSON.stringify({
                version: 1,
                workspaces: [],
                agents: [],
                tabs: [{ issue: 1, workspaceId: 'main', tabId: 'old-tab', createdAt: 'old' }],
            })
        )
        const handle = await h.runner.start({ name: 'flow-refine-1', ws: h.ws, kind: 'codex', owner: h.owner })
        expect(handle.tabId).toBe('owned-tab-0')
        expect(await h.owned.tab(1)).toMatchObject({ paneId: 'owned-agent-0' })
    })
    it('recreates a missing issue tab', async () => {
        const h = await agent()
        await h.runner.close(h.handle)
        const original = h.exec.run.getMockImplementation()!
        h.exec.run.mockImplementation(async (r) => {
            if (r.command === "herdr tab get 'owned-tab-0'") {
                throw new Error('tab_not_found')
            }
            return original(r)
        })
        const next = await h.runner.start({ name: 'flow-next-1', ws: h.ws, kind: 'codex', owner: h.owner })
        expect(next.tabId).toBe('owned-tab-1')
        expect((await h.owned.tab(1))?.tabId).toBe('owned-tab-1')
    })
    it('closes only the pane of an agent recorded before tabs were tracked', async () => {
        const h = await setup()
        h.setLive([{ name: 'flow-refine-1', pane_id: 'old-pane', agent_status: 'idle', agent_session: { value: 's' } }])
        const handle = { runner: 'herdr', name: 'flow-refine-1', paneId: 'old-pane', sessionId: 's' }
        await h.owned.addAgent(handle, h.owner, h.ws)
        await h.runner.close(handle)
        expect(h.exec.run.mock.calls.filter(([r]) => r.mutation).map(([r]) => r.command)).toEqual([
            "herdr agent send-keys 'flow-refine-1' ctrl+c",
            "herdr pane close 'old-pane'",
        ])
    })
    it('never closes a pane for an unowned or replaced session', async () => {
        const h = await agent()
        h.exec.run.mockClear()
        await expect(h.runner.close({ ...h.handle, name: 'human' })).rejects.toThrow('所有記録')
        h.setLive([
            {
                name: h.handle.name,
                pane_id: h.handle.paneId!,
                agent_status: 'idle',
                agent_session: { value: 'human-session' },
            },
        ])
        await expect(h.runner.close(h.handle)).rejects.toThrow('一致しません')
        expect(h.exec.run.mock.calls.filter(([r]) => r.mutation)).toEqual([])
    })
    it('writes adapter warnings while retaining valid worktree rows', async () => {
        const h = await setup()
        const warnings = vi.fn()
        h.exec.run.mockResolvedValue('w1\t1\tmain\t/project\nw2\t2\t\t/detached')
        const ws = new HerdrWorkspace(h.exec, h.w.workspace, h.w.vars, false, h.owned, warnings)
        expect(await ws.list()).toHaveLength(1)
        expect(warnings).toHaveBeenCalledWith(expect.stringContaining('/detached'))
    })
})

it('keeps the owned tab when stopping exits the agent', async () => {
    const h = await setup()
    vi.stubEnv('HERDR_PANE_ID', 'run-pane')
    const handle = await h.runner.start({ name: 'flow-refine-1', ws: h.ws, kind: 'codex', owner: h.owner })
    const original = h.exec.run.getMockImplementation()!
    h.exec.run.mockImplementation(async (r) => {
        if (r.command.startsWith('herdr agent send-keys')) {
            h.setLive([])
        }
        return original(r)
    })
    await h.runner.close(handle)
    expect(h.exec.run.mock.calls.some(([r]) => r.command.startsWith('herdr tab close'))).toBe(false)
})
