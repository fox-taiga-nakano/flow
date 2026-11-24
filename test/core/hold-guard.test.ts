import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { harness, starts, workflowFixture } from '../helpers.js'

const dirs: string[] = []
afterEach(async () => {
    for (const dir of dirs.splice(0)) {
        await fs.rm(dir, { recursive: true, force: true })
    }
})
async function setup(options: Parameters<typeof harness>[0] = {}) {
    const h = await harness(options)
    dirs.push(h.dir)
    return h
}
const label = (h: Awaited<ReturnType<typeof setup>>, labels: string[]) => {
    h.candidates[0]!.labels = labels
}

describe('hold label', () => {
    it('holds an Issue between steps and resumes from the original stage when the label is removed', async () => {
        const h = await setup({ stage: '再現済' })
        label(h, ['保留'])
        await h.o.tick()
        expect(h.stages.get(1)).toBe('保留')
        expect(await h.o.states.read(1)).toMatchObject({ status: 'stopped', gate: null, heldFromStage: '再現済' })
        expect(h.a.runner.start).not.toHaveBeenCalled()
        await h.make().tick()
        expect(h.stages.get(1)).toBe('保留')
        expect(h.a.runner.start).not.toHaveBeenCalled()
        label(h, [])
        await h.make().tick()
        expect(h.stages.get(1)).toBe('再現済')
        const s = await h.o.states.read(1)
        expect(s?.heldFromStage).toBeUndefined()
        expect(s).toMatchObject({ step: 'refine', status: 'running' })
    })
    it('waits for a running step and its after gate, then holds before the next step', async () => {
        const h = await setup()
        await h.o.tick()
        label(h, ['保留'])
        await h.o.tick()
        expect(h.stages.get(1)).toBe('未着手')
        expect((await h.o.states.read(1))?.status).toBe('running')
        vi.mocked(h.a.runner.status).mockResolvedValue('done')
        await h.result(1)
        for (const f of h.workflow.steps.repro!.done_when!.files!) {
            await h.file(1, f)
        }
        await h.o.tick()
        expect((await h.o.states.read(1))?.gate?.name).toBe('repro_result')
        expect(h.stages.get(1)).toBe('未着手')
        await h.o.control(1, 'approve')
        expect(h.stages.get(1)).toBe('再現済')
        await h.o.tick()
        expect(h.stages.get(1)).toBe('保留')
        expect(await h.o.states.read(1)).toMatchObject({ status: 'stopped', heldFromStage: '再現済' })
        expect(starts(h.a)).toHaveLength(1)
    })
    it('holds while waiting for a start gate and asks for it again after resuming', async () => {
        const h = await setup()
        h.workflow.gates.start = 'manual'
        await h.o.tick()
        expect((await h.o.states.read(1))?.gate?.name).toBe('start')
        label(h, ['保留'])
        await h.o.tick()
        expect(h.stages.get(1)).toBe('保留')
        expect(await h.o.states.read(1)).toMatchObject({ status: 'stopped', gate: null, heldFromStage: '未着手' })
        label(h, [])
        await h.o.tick()
        expect(h.stages.get(1)).toBe('未着手')
        expect((await h.o.states.read(1))?.gate?.name).toBe('start')
        expect(h.a.runner.start).not.toHaveBeenCalled()
    })
    it('leaves rejected Issues and other labels alone', async () => {
        const h = await setup({ stage: '対象外' })
        label(h, ['保留'])
        await h.o.tick()
        expect(h.stages.get(1)).toBe('対象外')
        const other = await setup({ stage: '再現済' })
        other.candidates[0]!.labels = ['bug']
        await other.o.tick()
        expect(other.stages.get(1)).toBe('再現済')
    })
    it('reject while held keeps the stage before the hold, and retry restores it', async () => {
        const h = await setup({ stage: '再現済' })
        label(h, ['保留'])
        await h.o.tick()
        await h.o.control(1, 'reject', { reason: '手で進める' })
        expect(h.stages.get(1)).toBe('対象外')
        expect(await h.o.states.read(1)).toMatchObject({ rejectedFromStage: '再現済' })
        expect((await h.o.states.read(1))?.heldFromStage).toBeUndefined()
        await h.o.control(1, 'retry')
        expect(h.stages.get(1)).toBe('再現済')
    })
    it('retry while held restores the stage; the label holds it again on the next tick', async () => {
        const h = await setup({ stage: '再現済' })
        label(h, ['保留'])
        await h.o.tick()
        await h.o.control(1, 'retry')
        expect(h.stages.get(1)).toBe('再現済')
        expect((await h.o.states.read(1))?.heldFromStage).toBeUndefined()
        await h.o.tick()
        expect(h.stages.get(1)).toBe('保留')
        expect(h.a.runner.start).not.toHaveBeenCalled()
    })
})

describe('guard system prompt', () => {
    it('gives the agent the rendered guard as a system prompt file', async () => {
        const h = await setup()
        await h.o.tick()
        const specs = vi.mocked(h.a.runner.start).mock.calls.map(([spec]) => [spec.name, spec.systemPromptFile])
        expect(specs).toEqual([['flow-repro-1', path.join(h.dir, 'run/guard/flow-repro-1.md')]])
        const text = await fs.readFile(specs[0]![1]!, 'utf8')
        expect(text).toContain('Issue #1 の 1 つの step')
        expect(text).toContain('頼まれても実行しません')
    })
    it('starts without a system prompt file when WORKFLOW has no guard', async () => {
        const h = await setup({ stage: '再現済' })
        delete h.workflow.prompts.guard
        await h.o.tick()
        expect(vi.mocked(h.a.runner.start).mock.calls[0]![0].systemPromptFile).toBeUndefined()
    })
})

describe('hold configuration', () => {
    it('requires hold_labels and held together', async () => {
        const workflow = await workflowFixture()
        expect(() =>
            workflow((raw) => {
                delete raw.stage_store.held
            })
        ).toThrow('セットで指定')
    })
    it('rejects a held stage equal to rejected or used as when_stage', async () => {
        const workflow = await workflowFixture()
        expect(() =>
            workflow((raw) => {
                raw.stage_store.held = '対象外'
            })
        ).toThrow('stage_store.held は initial・rejected と異なる')
        expect(() =>
            workflow((raw) => {
                raw.stage_store.held = '再現済'
            })
        ).toThrow('stage_store.held を when_stage に指定できません')
    })
})
