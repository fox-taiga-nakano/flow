import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { CopilotRemote, normalizeAuthor, remoteStatus } from '../../src/adapters/copilot.js'
import { DirsStageStore } from '../../src/adapters/dirs.js'
import { ShellExec } from '../../src/adapters/exec.js'
import { GitHubTracker, parseIssue, parsePR } from '../../src/adapters/github.js'
import { HerdrRunner, HerdrWorkspace, pairs, parseAgents, parseWorkspaces } from '../../src/adapters/herdr.js'
import { Ownership } from '../../src/core/ownership.js'
import type { ExecRequest } from '../../src/core/types.js'
import { config, issue, pr, temp } from '../helpers.js'

const fixture = (f: string) => fs.readFile(path.join(import.meta.dirname, '../fixtures', f), 'utf8')
const dirs: string[] = []
afterEach(async () => {
    for (const d of dirs.splice(0)) {
        await fs.rm(d, { recursive: true, force: true })
    }
})
describe('recorded CLI output parsing', () => {
    it('parses actual wt:list TSV including occupied slots', async () => {
        const ws = parseWorkspaces(await fixture('wt-list.tsv'))
        expect(ws.map((w) => w.slot)).toEqual([0, 3, 2])
        expect(ws[2]?.workspaceId).toBe('w1K')
    })
    it('parses wt:create, wt:agent, pr:info last lines including paths with spaces', () => {
        expect(pairs('copied file\nworktree=/home/a/my tree workspace=w1N pane=w1N:p2')).toEqual({
            worktree: '/home/a/my tree',
            workspace: 'w1N',
            pane: 'w1N:p2',
        })
        expect(pairs('agent=verify-3740 workspace=w1N pane=w1N:p2').pane).toBe('w1N:p2')
        expect(pairs('pr=4050 branch=copilot/layout base=delivery/20261023 issue=3740 migrations=').issue).toBe('3740')
    })
    it('parses current Herdr lifecycle JSON and gh aliases', () => {
        expect(
            parseAgents('{"result":{"agents":[{"name":"verify-3170","pane_id":"w1K:p2","agent_status":"idle"}]}}')[0]
                ?.agent_status
        ).toBe('idle')
        expect(normalizeAuthor('app/copilot-swe-agent')).toBe('copilot-swe-agent')
        expect(normalizeAuthor('Copilot[bot]')).toBe('copilot')
        expect(
            parseIssue({
                ...issue(),
                state: 'OPEN',
                assignees: [{ login: 'me' }],
                labels: [{ name: 'priority:2' }],
            }).labels
        ).toEqual(['priority:2'])
        expect(
            parsePR({
                number: 4050,
                headRefName: 'copilot/branch',
                baseRefName: 'delivery/20261023',
                state: 'OPEN',
                isDraft: false,
                author: { login: 'app/copilot-swe-agent' },
                url: 'url',
            }).branch
        ).toBe('copilot/branch')
    })
    it('uses the observed Copilot review request despite later independent review job', async () => {
        const events = JSON.parse(await fixture('timeline-4050.json'))
        expect(remoteStatus(events, 'review_requested', ['Copilot'], true)).toBe('done')
        expect(remoteStatus(events, 'timeline', ['Copilot'], true)).toBe('working')
        expect(remoteStatus(events, 'not_draft', [], false)).toBe('done')
    })
})
describe('adapters through fake exec', () => {
    it('dry-run skips mutations without evaluating shell and allows reads', async () => {
        const output = vi.fn()
        const exec = new ShellExec(true, output)
        await exec.run({ command: 'exit 99', mutation: true })
        expect(exec.planned).toHaveLength(1)
        expect(output).toHaveBeenCalledWith(expect.stringContaining('MUTATION SKIPPED'))
        expect(await exec.run({ command: 'printf read', mutation: false })).toBe('read')
    })
    it('discovers only closing PRs and filters excluded issues', async () => {
        const w = await config()
        w.tracker.exclude_labels = ['hold']
        const exec = {
            run: vi.fn(async (r) =>
                r.command.startsWith('gh issue list')
                    ? JSON.stringify([
                          {
                              ...issue(),
                              state: 'OPEN',
                              assignees: [{ login: 'me' }],
                              labels: [{ name: 'hold' }],
                          },
                      ])
                    : JSON.stringify([
                          {
                              number: 1,
                              headRefName: 'a',
                              baseRefName: 'main',
                              state: 'OPEN',
                              author: { login: 'a' },
                              url: '',
                              isDraft: true,
                              closingIssuesReferences: [{ number: 5 }],
                          },
                      ])
            ),
        }
        const tracker = new GitHubTracker(exec, w.tracker, '/tmp')
        expect(await tracker.listCandidates()).toEqual([])
        expect((await tracker.findPullRequests(5)).map((p) => p.number)).toEqual([1])
    })
    it('does not turn auth errors into missing issues', async () => {
        const w = await config()
        const tracker = new GitHubTracker({ run: vi.fn().mockRejectedValue(new Error('HTTP 401')) }, w.tracker, '/tmp')
        await expect(tracker.getIssue(1)).rejects.toThrow('401')
    })
    it('uses configured directory pattern and only previews ensure/set in dry-run', async () => {
        const w = await config()
        const e = {
            run: vi.fn(async (_r: ExecRequest) => '/project/issues/2-検証済_3740'),
        }
        const store = new DirsStageStore(e, w.stage_store, w.vars, true)
        expect(await store.get(3740)).toBe('検証済')
        await store.set(3740, '完了')
        expect(await store.get(3740)).toBe('完了')
        expect(e.run.mock.calls.at(-1)?.[0].mutation).toBe(true)
    })
    it('reads the global issue:mark rejected directory 0-対象外_<issue>', async () => {
        const w = await config()
        const exec = { run: vi.fn(async () => '/project/.dev/issues/0-対象外_3953') }
        const store = new DirsStageStore(exec, w.stage_store, w.vars)
        expect(await store.get(3953)).toBe('対象外')
        expect(await store.dir(3953)).toBe('/project/.dev/issues/0-対象外_3953')
        expect(exec.run.mock.calls).toHaveLength(1)
        expect(exec.run).toHaveBeenCalledWith(expect.objectContaining({ mutation: false }))
    })
    it('polls pending, authored PR, paginated timeline and ignores stale signal after NG comment', async () => {
        const w = await config()
        const tracker = {
            listCandidates: vi.fn(),
            getIssue: vi.fn(),
            findPullRequests: vi.fn(async () => [pr()]),
        }
        const e = {
            run: vi.fn(async (_r: ExecRequest) => JSON.stringify([JSON.parse(await fixture('timeline-4050.json'))])),
        }
        const remote = new CopilotRemote(e, tracker, w.steps.implement!, w)
        expect(await remote.poll(1)).toBe('done')
        expect(await remote.poll(1, '2026-10-21T00:00:00Z')).toBe('working')
        tracker.findPullRequests.mockResolvedValue([])
        expect(await remote.poll(1)).toBe('pending')
        expect(e.run.mock.calls[0]?.[0].mutation).toBe(false)
    })
    it('matches a user-authored Copilot PR by its branch and work timeline', async () => {
        const w = await config()
        const copilot = { ...pr(101), author: 'octocat', branch: 'copilot/fix-layout' }
        const manual = { ...pr(102), author: 'octocat', branch: 'copilot/manual' }
        const tracker = {
            listCandidates: vi.fn(),
            getIssue: vi.fn(),
            findPullRequests: vi.fn(async () => [manual, copilot]),
        }
        const work = JSON.parse(await fixture('timeline-4050.json'))
        const exec = {
            run: vi.fn(async (r: ExecRequest) =>
                JSON.stringify([r.command.includes('/101/timeline') ? work : [{ event: 'review_requested' }]])
            ),
        }
        const remote = new CopilotRemote(exec, tracker, w.steps.implement!, w)
        expect(await remote.hasOpenPullRequest(1)).toBe(true)
        exec.run.mockClear()
        expect(await remote.poll(1)).toBe('done')
        expect(exec.run).toHaveBeenCalledTimes(2)
        expect(await remote.poll(1, '2026-10-21T00:00:00Z')).toBe('working')
        tracker.findPullRequests.mockResolvedValue([manual, { ...pr(103), author: 'octocat' }])
        expect(await remote.hasOpenPullRequest(1)).toBe(false)
        expect(await remote.poll(1)).toBe('pending')
        tracker.findPullRequests.mockResolvedValue([copilot, pr(104)])
        await expect(remote.hasOpenPullRequest(1)).rejects.toThrow('Copilot の open PR が複数')
    })
    it('reuses existing workspace without creating it and refuses dirty cleanup', async () => {
        const w = await config()
        const exec = {
            run: vi.fn(async (r) =>
                r.command === 'mise wt:list'
                    ? await fixture('wt-list.tsv')
                    : r.command === 'git status --porcelain'
                      ? ' M changed'
                      : ''
            ),
        }
        const dir = await temp()
        dirs.push(dir)
        const owned = new Ownership(dir)
        const existing = parseWorkspaces(await fixture('wt-list.tsv'))[1]!
        await owned.addWorkspace(existing, { issue: 3737, step: 'verify' }, 'adopted')
        const original = exec.run.getMockImplementation()!
        exec.run.mockImplementation(async (r) =>
            r.command === 'herdr agent list' ? '{"result":{"agents":[]}}' : original(r)
        )
        const ws = new HerdrWorkspace(exec, w.workspace, w.vars, false, owned)
        const found = await ws.ensure({
            key: 'test',
            branch: 'copilot/1264-fix-layout',
            owner: { issue: 3737, step: 'verify' },
        })
        expect(found.slot).toBe(3)
        expect(exec.run.mock.calls.every(([r]) => !r.mutation)).toBe(true)
        await expect(ws.remove(found)).rejects.toThrow('未コミット')
    })
    it('targets agent names, maps missing agents to gone and unknown to working', async () => {
        const w = await config()
        const e = {
            run: vi.fn(
                async () => '{"result":{"agents":[{"name":"flow-a","pane_id":"w1:p1","agent_status":"unknown"}]}}'
            ),
        }
        const dir = await temp()
        dirs.push(dir)
        const owned = new Ownership(dir)
        await owned.addAgent(
            { runner: 'herdr', name: 'flow-a', paneId: 'w1:p1' },
            { issue: 1, step: 'verify' },
            { key: 'a', path: '/test', branch: 'b', workspaceId: 'w1', slot: 1 }
        )
        const runner = new HerdrRunner(e, w.runner, String(w.vars.main), false, owned)
        await runner.focusTab('tab 1')
        expect(e.run).toHaveBeenCalledWith(
            expect.objectContaining({ command: "herdr tab focus 'tab 1'", mutation: true })
        )
        expect(await runner.status({ runner: 'herdr', name: 'missing' })).toBe('gone')
        expect(await runner.status({ runner: 'herdr', name: 'flow-a', paneId: 'w1:p1' })).toBe('working')
    })
})
