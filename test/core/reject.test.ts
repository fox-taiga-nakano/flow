import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { DirsStageStore } from '../../src/adapters/dirs.js'
import { initialState } from '../../src/core/state.js'
import type { ExecRequest, Status } from '../../src/core/types.js'
import { harness, pr, workflowFixture } from '../helpers.js'

const dirs: string[] = []
async function setup(options: Parameters<typeof harness>[0] = {}) {
    const h = await harness(options)
    dirs.push(h.dir)
    return h
}
afterEach(async () => {
    for (const d of dirs.splice(0)) {
        await fs.rm(d, { recursive: true, force: true })
    }
})
it('rejects an existing gate, records the original stage and reason, and retry restores the stage', async () => {
    const h = await setup()
    h.workflow.gates.start = 'manual'
    await h.o.tick()
    await h.o.control(1, 'reject', { gate: 'start', reason: '再現対象外' })
    expect(h.stages.get(1)).toBe('対象外')
    expect(await h.o.states.read(1)).toMatchObject({
        status: 'stopped',
        gate: null,
        rejectedFromStage: '未着手',
        history: [expect.objectContaining({ result: 'reject', reason: '再現対象外' })],
    })
    await h.make().tick()
    expect(h.a.runner.start).not.toHaveBeenCalled()
    await h.make().control(1, 'retry')
    expect(h.stages.get(1)).toBe('未着手')
    expect((await h.o.states.read(1))?.rejectedFromStage).toBeUndefined()
    await h.make().tick()
    expect((await h.o.states.read(1))?.gate?.name).toBe('start')
    expect(h.a.runner.start).not.toHaveBeenCalled()
})
it('rejects the configured start gate without a directory or persisted dry-run state', async () => {
    const h = await setup()
    h.workflow.gates.start = 'manual'
    h.stages.delete(1)
    await fs.rm(h.files.get(1)!, { recursive: true, force: true })
    vi.mocked(h.a.stages.dir).mockImplementation(async (n) => {
        if (!h.stages.has(n)) {
            throw new Error('ディレクトリがありません')
        }
        return h.files.get(n)!
    })
    vi.mocked(h.a.stages.ensure).mockImplementation(async (n) => {
        h.stages.set(n, '未着手')
        await fs.mkdir(h.files.get(n)!, { recursive: true })
        return h.files.get(n)!
    })
    await h.o.control(1, 'reject', { gate: 'start', reason: '不要' })
    expect(h.a.stages.ensure).toHaveBeenCalledWith(1)
    expect(h.stages.get(1)).toBe('対象外')
    expect(await h.o.states.read(1)).toMatchObject({
        step: 'repro',
        status: 'stopped',
        rejectedFromStage: '未着手',
    })
    expect(h.a.runner.start).not.toHaveBeenCalled()
    expect(h.a.workspace.ensure).not.toHaveBeenCalled()
})
it('rejects a planned finish gate with no state and restores its actual non-initial stage', async () => {
    const h = await setup({ stage: '検証済' })
    h.prs.set(1, [pr()])
    await h.o.control(1, 'reject', { gate: 'finish_start' })
    expect(h.stages.get(1)).toBe('対象外')
    expect((await h.o.states.read(1))?.rejectedFromStage).toBe('検証済')
    await h.o.control(1, 'retry')
    expect(h.stages.get(1)).toBe('検証済')
    await h.o.tick()
    expect((await h.o.states.read(1))?.gate?.name).toBe('finish_start')
})
it('does not create or change directories for a wrong gate without state', async () => {
    const h = await setup()
    h.workflow.gates.start = 'manual'
    h.stages.delete(1)
    await expect(h.o.control(1, 'reject', { gate: 'finish_start' })).rejects.toThrow('gate')
    expect(h.a.stages.ensure).not.toHaveBeenCalled()
    expect(h.a.stages.set).not.toHaveBeenCalled()
    expect(await h.o.states.read(1)).toBeNull()
})
it('does not manufacture an after gate, an automatic gate or a nonexistent issue', async () => {
    const h = await setup({ stage: '再現済' })
    await expect(h.o.control(1, 'reject', { gate: 'issue_push' })).rejects.toThrow('gate')
    h.stages.set(1, '未着手') // harness start is automatic, so there is no waiting gate.
    await expect(h.o.control(1, 'reject', { gate: 'start' })).rejects.toThrow('gate')
    await expect(h.o.control(999, 'reject')).rejects.toThrow('Issue がありません')
    expect(h.a.stages.ensure).not.toHaveBeenCalled()
    expect(h.a.stages.set).not.toHaveBeenCalled()
})
it('does not allocate any step, including merged cleanup, for the rejected stage', async () => {
    const h = await setup({ stage: '対象外' })
    const p = pr()
    p.state = 'merged'
    h.prs.set(1, [p])
    await h.o.tick()
    await h.o.tick()
    expect((await h.o.states.read(1))?.step).toBeNull()
    expect(h.a.runner.start).not.toHaveBeenCalled()
    expect(h.a.workspace.ensure).not.toHaveBeenCalled()
    expect(h.a.workspace.remove).not.toHaveBeenCalled()
    expect(h.a.stages.set).not.toHaveBeenCalled()
})
it('stop and retry leave the stage unchanged when no rejection was recorded', async () => {
    const h = await setup()
    h.workflow.gates.start = 'manual'
    await h.o.tick()
    await h.o.control(1, 'stop')
    await h.o.control(1, 'retry')
    expect(h.stages.get(1)).toBe('未着手')
    expect(h.a.stages.set).not.toHaveBeenCalled()
})
it('uses the configured rejected stage rather than a hard-coded label', async () => {
    const h = await setup()
    h.workflow.stage_store.rejected = '除外'
    h.workflow.gates.start = 'manual'
    await h.o.tick()
    await h.o.control(1, 'reject')
    expect(h.stages.get(1)).toBe('除外')
    await h.o.tick()
    expect(h.a.runner.start).not.toHaveBeenCalled()
})
it('validates the rejected stage and forbids assigning it to a step', async () => {
    const workflow = await workflowFixture()
    expect(() =>
        workflow((raw) => {
            delete raw.stage_store.rejected
        })
    ).toThrow('rejected')
    expect(() =>
        workflow((raw) => {
            raw.stage_store.rejected = '未着手'
        })
    ).toThrow('rejected')
    expect(() =>
        workflow((raw) => {
            raw.steps.repro.when_stage = '対象外'
        })
    ).toThrow('when_stage')
})
it('preserves the recorded stage if a mark fails and the user repeats reject', async () => {
    const h = await setup()
    h.workflow.gates.start = 'manual'
    await h.o.tick()
    vi.mocked(h.a.stages.set).mockRejectedValueOnce(new Error('mark unavailable'))
    await expect(h.o.control(1, 'reject')).rejects.toThrow('mark unavailable')
    expect((await h.o.states.read(1))?.rejectedFromStage).toBe('未着手')
    await h.o.control(1, 'reject')
    await h.o.control(1, 'retry')
    expect(h.stages.get(1)).toBe('未着手')
})
it('does not overwrite corrupt state while rejecting', async () => {
    const h = await setup()
    h.workflow.gates.start = 'manual'
    const file = path.join(h.files.get(1)!, 'flow/state.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, 'null')
    await expect(h.o.control(1, 'reject')).rejects.toThrow('state.json')
    expect(h.a.stages.ensure).not.toHaveBeenCalled()
    expect(await fs.readFile(file, 'utf8')).toBe('null')
})
it('keeps state through real directory moves using DirsStageStore and a fake mise executor', async () => {
    const h = await setup()
    h.workflow.gates.start = 'manual'
    let current: string | null = null
    const initialDir = path.join(h.dir, 'issues/7-未着手_1')
    const rejectedDir = path.join(h.dir, 'issues/0-対象外_1')
    const exec = {
        run: vi.fn(async (r: ExecRequest) => {
            if (r.command.includes('issue:dir --create')) {
                current ??= initialDir
                await fs.mkdir(current, { recursive: true })
                return current
            }
            if (r.command.includes('issue:mark')) {
                const target = r.command.includes("'対象外'") ? rejectedDir : initialDir
                if (current !== target) {
                    await fs.rename(current!, target)
                    current = target
                }
                return current!
            }
            if (!current) {
                throw new Error('Issue #1 のディレクトリがありません (--create で作成)')
            }
            return current
        }),
    }
    h.a.stages = new DirsStageStore(exec, h.workflow.stage_store, h.workflow.vars)
    const o = h.make()
    await o.control(1, 'reject', { gate: 'start', reason: '不要' })
    expect(current).toBe(rejectedDir)
    expect(await h.a.stages.get(1)).toBe('対象外')
    expect(JSON.parse(await fs.readFile(path.join(rejectedDir, 'flow/state.json'), 'utf8'))).toMatchObject({
        status: 'stopped',
        rejectedFromStage: '未着手',
    })
    await h.make().control(1, 'retry')
    expect(current).toBe(initialDir)
    expect(JSON.parse(await fs.readFile(path.join(initialDir, 'flow/state.json'), 'utf8'))).toMatchObject({
        status: 'idle',
    })
    await expect(fs.access(rejectedDir)).rejects.toThrow()
    expect(exec.run.mock.calls.filter(([r]) => r.mutation)).toHaveLength(3) // ensure + reject mark + retry mark
})
it('saves to the moved Issue directory after an external command renames it', async () => {
    const h = await setup()
    const before = path.join(h.dir, 'issues/2-検証済_1')
    const after = path.join(h.dir, 'issues/1-完了_1')
    let current = before
    await fs.mkdir(before, { recursive: true })
    const exec = {
        run: vi.fn(async (r: ExecRequest) => {
            if (r.command === 'mise issue:status --update') {
                await fs.rename(current, after)
                current = after
                return ''
            }
            return current
        }),
    }
    h.a.stages = new DirsStageStore(exec, h.workflow.stage_store, h.workflow.vars)
    h.a.exec = exec
    const o = h.make()
    const s = initialState(1)
    await o.save(s)
    expect(await o.command(s, 'mise issue:status --update', 'cleanup:action')).toBe(true)
    s.status = 'done'
    await o.save(s)
    expect(JSON.parse(await fs.readFile(path.join(after, 'flow/state.json'), 'utf8'))).toMatchObject({
        status: 'done',
        effects: ['cleanup:action'],
    })
    expect(JSON.parse(await fs.readFile(path.join(after, 'flow/state.json'), 'utf8'))).not.toHaveProperty('inflight')
    await expect(fs.access(before)).rejects.toThrow()
})
describe('reject without a gate', () => {
    it.each(['retry_wait', 'failed', 'stopped', 'idle', 'done', 'waiting_remote'] as Status[])(
        'rejects %s without a gate and retry restores the original stage',
        async (status) => {
            const h = await setup({ stage: '修正中' })
            const s = initialState(1)
            s.status = status
            await h.o.save(s)
            await h.o.control(1, 'reject', { reason: '対象外' })
            expect(h.stages.get(1)).toBe('対象外')
            expect((await h.o.states.read(1))?.history.at(-1)?.reason).toBe('対象外')
            await h.o.control(1, 'retry')
            expect(h.stages.get(1)).toBe('修正中')
        }
    )
    it('rejects an unregistered Issue without a gate, and ensures its directory', async () => {
        const h = await setup()
        h.stages.delete(1)
        await h.o.control(1, 'reject')
        expect(h.a.runner.closeIssueTab).toHaveBeenCalledWith(1)
        expect(h.a.stages.ensure).toHaveBeenCalledWith(1)
        expect(h.stages.get(1)).toBe('対象外')
    })
    it('still refuses an explicit nonexistent gate', async () => {
        const h = await setup()
        await h.o.save(initialState(1))
        await expect(h.o.control(1, 'reject', { gate: 'start' })).rejects.toThrow('gate')
        expect(h.a.stages.set).not.toHaveBeenCalled()
    })
    it('stops a running owned agent before marking the Issue rejected', async () => {
        const h = await setup()
        await h.o.tick()
        vi.mocked(h.a.stages.set).mockImplementation(async (n, s) => {
            expect(h.a.runner.stop).toHaveBeenCalledTimes(1)
            h.stages.set(n, s)
        })
        await h.o.control(1, 'reject')
        expect(h.stages.get(1)).toBe('対象外')
        expect(vi.mocked(h.a.runner.close).mock.calls.map(([a]) => a.name)).toEqual(['flow-repro-1'])
    })
})
