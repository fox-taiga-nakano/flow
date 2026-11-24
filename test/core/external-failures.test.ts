import { promises as fs } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { ShellExec } from '../../src/adapters/exec.js'
import { parseAgents, parseWorkspaces } from '../../src/adapters/herdr.js'
import { CommandError } from '../../src/core/command-error.js'
import { harness, starts } from '../helpers.js'

const dirs: string[] = []
async function setup(options: Parameters<typeof harness>[0] = {}) {
    const h = await harness(options)
    dirs.push(h.dir)
    return h
}
afterEach(async () => {
    vi.restoreAllMocks()
    for (const d of dirs.splice(0)) {
        await fs.rm(d, { recursive: true, force: true })
    }
})

describe('invalid external lists are isolated', () => {
    it('skips detached/malformed worktrees and malformed agents with a warning per row', () => {
        const warn = vi.fn()
        expect(
            parseWorkspaces(
                'w1\t1\tmain\t/project\nw2\t2\t\t/detached\nbad\nw3\t-\tfeature\t/project/feature',
                warn
            ).map((w) => w.branch)
        ).toEqual(['main', 'feature'])
        expect(warn).toHaveBeenCalledTimes(2)
        expect(
            parseAgents(
                JSON.stringify({ result: { agents: [null, { name: 'bad' }, { pane_id: 'p', agent_status: 'idle' }] } }),
                warn
            )
        ).toHaveLength(1)
        expect(warn).toHaveBeenCalledTimes(4)
    })
    it('continues processing other Issues when the initial workspace list fails, without reclaiming locks', async () => {
        const h = await setup({ count: 2 })
        vi.mocked(h.a.workspace.list).mockRejectedValueOnce(new Error('workspace unavailable'))
        const reclaim = vi.spyOn(h.o.locks, 'reclaim')
        const rows = await h.o.tick()
        expect(reclaim).not.toHaveBeenCalled()
        expect(rows).toHaveLength(2)
        expect(starts(h.a)).toHaveLength(2)
        expect((await h.o.events.read()).some((e) => e.message.includes('workspace unavailable'))).toBe(true)
    })
})

describe('external command diagnostics', () => {
    it('includes exit code and only the stderr tail', async () => {
        const exec = new ShellExec()
        let failure: CommandError | undefined
        try {
            await exec.run({ command: 'for ((i=1;i<=60;i++)); do echo line-$i >&2; done; exit 13', mutation: false })
        } catch (e) {
            failure = e as CommandError
        }
        expect(failure).toBeInstanceOf(CommandError)
        expect(failure!.details).toMatchObject({ exitCode: 13, signal: null, timedOut: false })
        expect(failure!.details.stderr.split('\n')).toHaveLength(40)
        expect(String(failure)).toContain('line-60')
        expect(String(failure)).not.toContain('line-20\n')
    })
    it('records termination signals and distinguishes a timeout', async () => {
        const exec = new ShellExec()
        await expect(exec.run({ command: 'kill -TERM $$', mutation: false })).rejects.toMatchObject({
            details: { signal: 'SIGTERM', timedOut: false },
        })
        await expect(exec.run({ command: 'exec /bin/sleep 1', mutation: false, timeoutMs: 20 })).rejects.toMatchObject({
            details: { signal: 'SIGTERM', timedOut: true },
        })
    })
    it('persists structured command failure details in events and the Issue history', async () => {
        const h = await setup()
        const error = new CommandError(
            'mise issue:dir 4005',
            Object.assign(new Error('failed'), { code: 7, stderr: 'specific failure', signal: 'SIGTERM', killed: true })
        )
        vi.mocked(h.a.workspace.ensure).mockRejectedValueOnce(error)
        await h.o.tick()
        expect((await h.o.states.read(1))?.history.at(-1)?.reason).toContain('specific failure')
        expect((await h.o.events.read()).find((e) => e.event === 'command_error')?.commandFailure).toMatchObject({
            exitCode: 7,
            stderr: 'specific failure',
            signal: 'SIGTERM',
            timedOut: true,
        })
    })
})

it('records stderr when the initial directory lookup fails, without preventing the next Issue', async () => {
    const h = await setup({ count: 2 })
    const error = new CommandError(
        'mise issue:dir 1',
        Object.assign(new Error('failed'), { code: 4, stderr: 'directory command failure' })
    )
    vi.mocked(h.a.stages.ensure).mockRejectedValueOnce(error)
    await h.o.tick()
    expect(starts(h.a)).toHaveLength(1)
    expect((await h.o.events.read(1)).find((e) => e.event === 'command_error')?.commandFailure?.stderr).toBe(
        'directory command failure'
    )
})
it('records command diagnostics for a failed reject even without a state file', async () => {
    const h = await setup()
    const error = new CommandError(
        'mise issue:dir 1',
        Object.assign(new Error('failed'), { code: 8, stderr: 'permission denied' })
    )
    vi.mocked(h.a.stages.get).mockRejectedValueOnce(error)
    await expect(h.o.control(1, 'reject')).rejects.toThrow('permission denied')
    expect((await h.o.events.read(1)).find((e) => e.event === 'command_error')?.commandFailure?.exitCode).toBe(8)
})
