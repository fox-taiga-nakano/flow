import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { parseWorkflow } from '../../src/core/workflow.js'
import { harness, pr, starts } from '../helpers.js'

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

describe('initial prompt readiness and pane completion', () => {
    it.each(['blocked', 'pending'] as const)(
        'does not send while %s and sends exactly once after readiness across restarts',
        async (ready) => {
            const h = await setup()
            vi.mocked(h.a.runner.ready).mockResolvedValue(ready)
            await h.o.tick()
            await h.make().tick()
            expect(h.a.runner.prompt).not.toHaveBeenCalled()
            expect(h.a.runner.close).not.toHaveBeenCalled()
            const waiting = (await h.o.states.read(1))!
            expect(waiting.initialPrompt).toContain('Issue: #1')
            if (ready === 'blocked') {
                expect(waiting.gate?.name).toBe('agent_question')
            }
            vi.mocked(h.a.runner.ready).mockResolvedValue('ready')
            await h.make().tick()
            await h.make().tick()
            expect(starts(h.a)).toHaveLength(1)
            expect(h.a.runner.prompt).toHaveBeenCalledTimes(1)
            expect((await h.o.states.read(1))?.initialPrompt).toBeUndefined()
        }
    )
    it.each(['applied', 'retry'])(
        'recovers an uncertain initial prompt with %s without starting twice',
        async (choice) => {
            const h = await setup()
            vi.mocked(h.a.runner.prompt).mockRejectedValueOnce(new Error('delivery unknown'))
            await h.o.tick()
            expect((await h.o.states.read(1))?.gate?.name).toBe('operation_recovery')
            await h.make().tick()
            expect(h.a.runner.prompt).toHaveBeenCalledTimes(1)
            await h.make().control(1, 'approve', { choice })
            await h.make().tick()
            await h.make().tick()
            expect(starts(h.a)).toHaveLength(1)
            expect(h.a.runner.prompt).toHaveBeenCalledTimes(choice === 'applied' ? 1 : 2)
        }
    )
    it('keeps after-gate and question panes, then closes only after transition', async () => {
        const h = await setup()
        await h.o.tick()
        vi.mocked(h.a.runner.status).mockResolvedValue('blocked')
        await h.o.tick()
        expect(h.a.runner.close).not.toHaveBeenCalled()
        vi.mocked(h.a.runner.status).mockResolvedValue('done')
        const s = (await h.o.states.read(1))!
        s.gate = null
        s.status = 'running'
        await h.o.save(s)
        await h.result(1)
        for (const f of h.workflow.steps.repro!.done_when!.files!) {
            await h.file(1, f)
        }
        await h.o.tick()
        expect(h.a.runner.close).not.toHaveBeenCalled()
        await h.o.control(1, 'approve')
        expect(vi.mocked(h.a.runner.close).mock.calls.map(([a]) => a.name)).toEqual(['flow-repro-1'])
        expect((await h.o.owned.read()).agents).toHaveLength(0)
    })
    it('keeps finish alive through approval and continuation, closes after its final result', async () => {
        const h = await setup({ stage: '検証済' })
        h.prs.set(1, [pr()])
        await h.o.tick()
        await h.o.control(1, 'approve')
        await h.o.tick()
        await h.file(1, 'pr-body.md')
        await h.result(1)
        vi.mocked(h.a.runner.status).mockResolvedValue('done')
        await h.o.tick()
        await h.o.control(1, 'approve')
        expect(h.a.runner.close).not.toHaveBeenCalled()
        await h.result(1)
        await h.o.tick()
        expect(vi.mocked(h.a.runner.close).mock.calls.map(([a]) => a.name)).toEqual(['flow-finish-1'])
    })
    it('honors close_on_complete false and refuses to close unowned agents', async () => {
        const h = await setup()
        await h.o.tick()
        const s = (await h.o.states.read(1))!
        h.workflow.runner.close_on_complete = false
        await h.o.transition(s, { stop: true })
        expect(h.a.runner.close).not.toHaveBeenCalled()
        h.workflow.runner.close_on_complete = true
        s.agent = { runner: 'herdr', name: 'human', paneId: 'human:p1' }
        s.worker = { runner: 'herdr', name: 'human-wt', paneId: 'human:p2' }
        await h.o.transition(s, { stop: true })
        expect(h.a.runner.close).not.toHaveBeenCalled()
    })
    it('defaults close_on_complete to true and validates its type', async () => {
        const source = await fs.readFile(path.resolve(import.meta.dirname, '../fixtures/WORKFLOW.md'), 'utf8')
        expect(parseWorkflow(source.replace('  close_on_complete: true\n', '')).runner.close_on_complete).toBe(true)
        expect(() => parseWorkflow(source.replace('close_on_complete: true', 'close_on_complete: nope'))).toThrow(
            'close_on_complete'
        )
    })
})
