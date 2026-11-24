import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { DirsStageStore } from '../../src/adapters/dirs.js'
import type { ExecRequest } from '../../src/core/types.js'
import { harness } from '../helpers.js'

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

describe('directory cache and unchanged states', () => {
    it('caches paths/stages within a tick, refreshes after moves and at the next tick', async () => {
        const h = await setup()
        let dir = '/project/1-未着手_1'
        const e = {
            run: vi.fn(async (r: ExecRequest) => {
                if (r.command.includes('issue:mark')) {
                    dir = '/project/0-対象外_1'
                }
                return dir
            }),
        }
        const store = new DirsStageStore(e, h.workflow.stage_store, h.workflow.vars)
        store.beginTick()
        await store.ensure(1)
        await store.dir(1)
        expect(await store.get(1)).toBe('未着手')
        expect(e.run).toHaveBeenCalledTimes(1)
        await store.set(1, '対象外')
        expect(await store.dir(1)).toBe('/project/0-対象外_1')
        expect(await store.get(1)).toBe('対象外')
        expect(e.run).toHaveBeenCalledTimes(3)
        dir = '/project/7-未着手_1'
        store.beginTick()
        expect(await store.get(1)).toBe('未着手')
        expect(e.run).toHaveBeenCalledTimes(4)
    })
    it('does not rewrite state, updatedAt, or the Issue index on an unchanged waiting tick', async () => {
        const h = await setup()
        h.workflow.gates.start = 'manual'
        await h.o.tick()
        const file = path.join(h.files.get(1)!, 'flow/state.json')
        const index = path.join(h.state, 'issues.json')
        const content = await fs.readFile(file, 'utf8')
        const before = await fs.stat(file)
        const indexBefore = await fs.stat(index)
        h.advance(10000)
        await h.make().tick()
        expect(await fs.readFile(file, 'utf8')).toBe(content)
        expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs)
        expect((await fs.stat(index)).mtimeMs).toBe(indexBefore.mtimeMs)
    })
    it('writes issues.json once after multiple new Issues and reads it once', async () => {
        const h = await setup({ count: 3 })
        h.workflow.gates.start = 'manual'
        const rename = vi.spyOn(fs, 'rename')
        const read = vi.spyOn(fs, 'readFile')
        await h.o.tick()
        const index = path.join(h.state, 'issues.json')
        expect(rename.mock.calls.filter(([, to]) => to === index)).toHaveLength(1)
        expect(read.mock.calls.filter(([file]) => file === index)).toHaveLength(1)
        expect(JSON.parse(await fs.readFile(index, 'utf8'))).toEqual([1, 2, 3])
    })
    it('does not rewrite a running state when the agent output remains unchanged', async () => {
        const h = await setup()
        await h.o.tick()
        await h.o.tick()
        const file = path.join(h.files.get(1)!, 'flow/state.json')
        const before = await fs.readFile(file, 'utf8')
        h.advance(1000)
        await h.make().tick()
        expect(await fs.readFile(file, 'utf8')).toBe(before)
    })
})

it('measures unchanged waiting Issue directory commands', async () => {
    const h = await harness()
    const dir = path.join(h.dir, 'issues/1-未着手_1')
    await fs.mkdir(dir, { recursive: true })
    const exec = { run: vi.fn(async () => dir) }
    h.a.stages = new DirsStageStore(exec, h.workflow.stage_store, h.workflow.vars)
    h.workflow.gates.start = 'manual'
    const o = h.make()
    await o.tick()
    exec.run.mockClear()
    await o.tick()
    const calls = exec.run.mock.calls.length
    expect(calls).toBe(1)
    await fs.rm(h.dir, { recursive: true, force: true })
})
