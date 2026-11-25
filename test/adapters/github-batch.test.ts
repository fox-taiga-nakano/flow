import { promises as fs } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { GitHubTracker, type RawIssue, type RawPR } from '../../src/adapters/github.js'
import { CommandError } from '../../src/core/command-error.js'
import { initialState } from '../../src/core/state.js'
import type { ExecRequest } from '../../src/core/types.js'
import { config, harness, issue, workflowFixture } from '../helpers.js'

const rawIssue = (n: number): RawIssue => ({
    ...issue(n),
    state: 'OPEN',
    assignees: [{ login: 'me' }],
    labels: [],
})
const rawPR = (n: number, issues: number[], state = 'OPEN'): RawPR => ({
    number: n,
    headRefName: `branch-${n}`,
    baseRefName: 'main',
    state,
    isDraft: false,
    author: { login: 'copilot-swe-agent' },
    url: `https://example.test/repo/pull/${n}`,
    closingIssuesReferences: issues.map((number) => ({ number, url: `https://example.test/repo/issues/${number}` })),
})
function graphql(rows: (RawIssue | null)[], numbers: number[]) {
    return JSON.stringify({
        data: {
            repository: Object.fromEntries(
                numbers.map((n, i) => {
                    const row = rows[i]
                    return [
                        `i${n}`,
                        row
                            ? {
                                  ...row,
                                  assignees: { nodes: row.assignees, pageInfo: { hasNextPage: false } },
                                  labels: { nodes: row.labels, pageInfo: { hasNextPage: false } },
                              }
                            : null,
                    ]
                })
            ),
        },
    })
}
const roots: string[] = []
afterEach(async () => {
    for (const root of roots.splice(0)) {
        await fs.rm(root, { recursive: true, force: true })
    }
})

describe('GitHub snapshots', () => {
    it('uses two GitHub reads for 16 candidates and their PRs throughout a real orchestrator tick', async () => {
        const h = await harness({ count: 16 })
        roots.push(h.dir)
        h.workflow.gates.start = 'manual'
        const exec = {
            run: vi.fn(async (r: ExecRequest) => {
                expect(r.mutation).toBe(false)
                if (r.command.startsWith('gh issue list')) {
                    return JSON.stringify(h.candidates.map((i) => rawIssue(i.number)))
                }
                if (r.command.startsWith('gh pr list')) {
                    return JSON.stringify(h.candidates.map((i) => rawPR(100 + i.number, [i.number])))
                }
                throw new Error(`Unexpected external command: ${r.command}`)
            }),
        }
        h.a.tracker = new GitHubTracker(exec, h.workflow.tracker, h.dir)
        const rows = await h.make().tick()
        expect(rows).toHaveLength(16)
        expect(rows.every((r) => r.status === 'waiting_gate' && r.gate === 'start')).toBe(true)
        expect(exec.run).toHaveBeenCalledTimes(2)
        expect(exec.run.mock.calls.every(([r]) => !/gh (issue|pr) view/.test(r.command))).toBe(true)
    })

    it('batches non-candidates and checks review requests before closed/unassigned cancellation', async () => {
        const h = await harness({ count: 4 })
        roots.push(h.dir)
        h.workflow.gates.start = 'manual'
        for (let n = 1; n <= 4; n++) {
            await h.o.states.write(initialState(n))
        }
        const exec = {
            run: vi.fn(async (r: ExecRequest) => {
                expect(r.mutation).toBe(false)
                if (r.command.startsWith('gh issue list')) {
                    return JSON.stringify([rawIssue(1)])
                }
                if (r.command.startsWith('gh pr list')) {
                    expect(r.command).toContain('reviewRequests')
                    return JSON.stringify([
                        {
                            ...rawPR(102, [2]),
                            reviewRequests: [{ __typename: 'User', login: 'reviewer-two' }],
                        },
                        {
                            ...rawPR(103, [3]),
                            reviewRequests: [{ __typename: 'Team', slug: 'reviewer-one' }],
                        },
                    ])
                }
                if (r.command.startsWith('gh api graphql')) {
                    expect(r.command).toContain('query($owner:String!,$repo:String!)')
                    expect(r.command).not.toMatch(/\bmutation\b/)
                    for (const n of [2, 3, 4]) {
                        expect(r.command).toContain(`i${n}: issue(number:${n})`)
                    }
                    return graphql(
                        [{ ...rawIssue(2), state: 'CLOSED' }, { ...rawIssue(3), assignees: [] }, null],
                        [2, 3, 4]
                    )
                }
                throw new Error(`Unexpected external command: ${r.command}`)
            }),
        }
        h.a.tracker = new GitHubTracker(exec, h.workflow.tracker, h.dir)
        const rows = await h.make().tick()
        expect(rows.find((r) => r.issue === 2)).toMatchObject({
            step: 'cleanup',
            status: 'waiting_gate',
            gate: 'cleanup',
        })
        for (const n of [3, 4]) {
            expect(rows.find((r) => r.issue === n)?.status).toBe('stopped')
        }
        expect(exec.run).toHaveBeenCalledTimes(3)
    })

    it('does not query stopped, done, or rejected issues even when absent from candidates', async () => {
        const h = await harness({ count: 4 })
        roots.push(h.dir)
        h.workflow.gates.start = 'manual'
        for (let n = 1; n <= 4; n++) {
            const state = initialState(n)
            if (n === 2) {
                state.status = 'stopped'
            }
            if (n === 3) {
                // マージ後の完了処理まで済んだ Issue。
                state.status = 'done'
                state.completed = ['cleanup', 'complete']
            }
            if (n === 4) {
                h.stages.set(n, h.workflow.stage_store.rejected)
            }
            await h.o.states.write(state)
        }
        h.a.tracker.listCandidates = vi.fn(async () => [issue(1)])
        h.a.tracker.prepareTick = vi.fn(async () => {})
        const rows = await h.make().tick()
        expect(h.a.tracker.prepareTick).toHaveBeenCalledWith([1])
        expect(h.a.tracker.getIssue).not.toHaveBeenCalled()
        expect(h.a.tracker.findPullRequests).not.toHaveBeenCalledWith(2)
        expect(h.a.tracker.findPullRequests).not.toHaveBeenCalledWith(3)
        expect(h.a.tracker.findPullRequests).not.toHaveBeenCalledWith(4)
        expect(rows.find((r) => r.issue === 3)?.status).toBe('done')
    })

    it('skips PR retrieval when all states are inactive', async () => {
        const w = await config()
        const exec = { run: vi.fn(async () => JSON.stringify([rawIssue(1)])) }
        const tracker = new GitHubTracker(exec, w.tracker, '/tmp')
        tracker.beginTick()
        await tracker.listCandidates()
        await tracker.prepareTick([])
        expect(await tracker.getIssue(1)).toBeNull()
        expect(await tracker.findPullRequests(1)).toEqual([])
        expect(exec.run).toHaveBeenCalledTimes(1)
    })

    it('splits large non-candidate sets into batches of 100 without individual views', async () => {
        const w = await config()
        const exec = {
            run: vi.fn(async (r: ExecRequest) => {
                if (r.command.startsWith('gh pr list')) {
                    return '[]'
                }
                const numbers = [...r.command.matchAll(/i(\d+): issue\(number:/g)].map((m) => Number(m[1]))
                expect(numbers.length).toBeLessThanOrEqual(100)
                return graphql(numbers.map(rawIssue), numbers)
            }),
        }
        const tracker = new GitHubTracker(exec, w.tracker, '/tmp')
        tracker.beginTick()
        await tracker.prepareTick(Array.from({ length: 201 }, (_, i) => i + 1))
        expect((await tracker.getIssue(201))?.number).toBe(201)
        expect(exec.run).toHaveBeenCalledTimes(4)
    })

    it('retains batch and PR failures without retry storms or treating them as missing data', async () => {
        const w = await config()
        const exec = {
            run: vi.fn(async (r: ExecRequest) => {
                throw new Error(r.command.startsWith('gh pr list') ? 'PR HTTP 503' : 'Issue HTTP 401')
            }),
        }
        const tracker = new GitHubTracker(exec, w.tracker, '/tmp')
        tracker.beginTick()
        await tracker.prepareTick([1, 2])
        for (const n of [1, 2]) {
            await expect(tracker.getIssue(n)).rejects.toThrow('401')
            await expect(tracker.findPullRequests(n)).rejects.toThrow('503')
        }
        expect(exec.run).toHaveBeenCalledTimes(2)
    })

    it('refreshes snapshots each tick and performs a fresh control lookup after the tick', async () => {
        const w = await config()
        let title = 'before'
        const exec = {
            run: vi.fn(async (r: ExecRequest) =>
                r.command.startsWith('gh pr list')
                    ? '[]'
                    : JSON.stringify(
                          r.command.startsWith('gh issue list')
                              ? [{ ...rawIssue(1), title }]
                              : { ...rawIssue(1), title }
                      )
            ),
        }
        const tracker = new GitHubTracker(exec, w.tracker, '/tmp')
        for (const next of ['before', 'after']) {
            title = next
            tracker.beginTick()
            await tracker.listCandidates()
            await tracker.prepareTick([1])
            expect((await tracker.getIssue(1))?.title).toBe(next)
            await tracker.findPullRequests(1)
            await tracker.findPullRequests(1)
            tracker.endTick()
        }
        title = 'control'
        expect((await tracker.getIssue(1))?.title).toBe('control')
        expect(exec.run.mock.calls.filter(([r]) => r.command.startsWith('gh pr list'))).toHaveLength(2)
    })

    it('indexes all PR states, multiple issues and PRs, duplicates, deleted authors, and cross-repository references', async () => {
        const w = await config()
        w.tracker.pr_limit = 77
        const merged = { ...rawPR(101, [1, 1, 2], 'MERGED'), author: null }
        const crossRepo = rawPR(104, [1])
        crossRepo.closingIssuesReferences![0]!.url = 'https://example.test/other/issues/1'
        const exec = {
            run: vi.fn(async (r: ExecRequest) => {
                expect(r.command).toContain('--state all --limit 77')
                return JSON.stringify([merged, rawPR(102, [1], 'CLOSED'), rawPR(103, [1]), crossRepo, rawPR(105, [])])
            }),
        }
        const tracker = new GitHubTracker(exec, w.tracker, '/tmp')
        expect((await tracker.findPullRequests(1)).map((p) => p.state)).toEqual(['merged', 'closed', 'open'])
        expect(await tracker.findPullRequests(2)).toEqual([expect.objectContaining({ number: 101, author: '' })])
        expect(await tracker.findPullRequests(3)).toEqual([])
        expect(exec.run).toHaveBeenCalledTimes(1)
    })

    it('does not accept missing fields or truncated assignees/labels as complete issue data', async () => {
        const w = await config()
        const response = JSON.parse(graphql([rawIssue(1)], [1]))
        response.data.repository.i1.labels.pageInfo.hasNextPage = true
        const exec = {
            run: vi.fn(async (r: ExecRequest) =>
                r.command.startsWith('gh pr list') ? '[]' : JSON.stringify(response)
            ),
        }
        const tracker = new GitHubTracker(exec, w.tracker, '/tmp')
        tracker.beginTick()
        await tracker.prepareTick([1, 2])
        await expect(tracker.getIssue(1)).rejects.toThrow('100')
        await expect(tracker.getIssue(2)).rejects.toThrow('#2')
    })

    it.each([0, -1, 1.5, '100'])('rejects invalid tracker.pr_limit %s', async (limit) => {
        const workflow = await workflowFixture()
        expect(() =>
            workflow((raw) => {
                raw.tracker.pr_limit = limit
            })
        ).toThrow('pr_limit')
    })
})

it('bounds directory preparation to four workers and isolates errors without changing dispatch order', async () => {
    const h = await harness({ count: 16 })
    roots.push(h.dir)
    h.workflow.gates.start = 'manual'
    let running = 0,
        peak = 0
    h.a.stages.ensure = vi.fn(async (n) => {
        running++
        peak = Math.max(peak, running)
        try {
            await Promise.resolve()
            if (n === 3) {
                throw new Error('directory unavailable')
            }
            return h.files.get(n)!
        } finally {
            running--
        }
    })
    const rows = await h.make().tick()
    expect(peak).toBe(4)
    expect(rows.map((r) => r.issue)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1).filter((n) => n !== 3))
    expect(rows.every((r) => r.status === 'waiting_gate')).toBe(true)
    expect(h.a.runner.start).not.toHaveBeenCalled()
})

it('rechecks a stopped Issue only after an explicit retry', async () => {
    const h = await harness()
    roots.push(h.dir)
    h.workflow.gates.start = 'manual'
    const state = initialState(1)
    state.status = 'stopped'
    await h.o.states.write(state)
    h.a.tracker.prepareTick = vi.fn(async () => {})
    await h.o.tick()
    expect(h.a.tracker.prepareTick).toHaveBeenLastCalledWith([])
    expect(h.a.tracker.findPullRequests).not.toHaveBeenCalled()
    await h.o.control(1, 'retry')
    await h.o.tick()
    expect(h.a.tracker.prepareTick).toHaveBeenLastCalledWith([1])
    expect(h.a.tracker.findPullRequests).toHaveBeenCalledWith(1)
})

it('keeps candidate processing working when the separate non-candidate batch fails', async () => {
    const h = await harness({ count: 2 })
    roots.push(h.dir)
    h.workflow.gates.start = 'manual'
    await h.o.states.write(initialState(2))
    const exec = {
        run: vi.fn(async (r: ExecRequest) => {
            if (r.command.startsWith('gh issue list')) {
                return JSON.stringify([rawIssue(1)])
            }
            if (r.command.startsWith('gh pr list')) {
                return '[]'
            }
            throw new Error('Issue batch HTTP 503')
        }),
    }
    h.a.tracker = new GitHubTracker(exec, h.workflow.tracker, h.dir)
    const rows = await h.make().tick()
    expect(rows.find((r) => r.issue === 1)).toMatchObject({ status: 'waiting_gate', gate: 'start' })
    expect((await h.o.events.read()).some((e) => e.message.includes('503'))).toBe(true)
    expect(exec.run).toHaveBeenCalledTimes(3)
})

it('preserves healthy aliases and missing Issues in a partial GraphQL command failure', async () => {
    const w = await config()
    const partial = JSON.parse(graphql([rawIssue(1), null], [1, 2]))
    partial.errors = [{ type: 'NOT_FOUND', path: ['repository', 'i2'], message: 'Could not resolve Issue 2' }]
    const exec = {
        run: vi.fn(async (r: ExecRequest) => {
            if (r.command.startsWith('gh pr list')) {
                return '[]'
            }
            throw new CommandError(
                r.command,
                Object.assign(new Error('exit 1'), {
                    code: 1,
                    stderr: 'gh: Could not resolve Issue 2',
                    stdout: JSON.stringify(partial),
                })
            )
        }),
    }
    const tracker = new GitHubTracker(exec, w.tracker, '/tmp')
    tracker.beginTick()
    await tracker.prepareTick([1, 2])
    expect((await tracker.getIssue(1))?.number).toBe(1)
    expect(await tracker.getIssue(2)).toBeNull()
    expect(exec.run).toHaveBeenCalledTimes(2)
})
