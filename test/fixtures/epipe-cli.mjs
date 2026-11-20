// Real CLI/core and on-disk stores; every external adapter is local and fake.
import { CommanderError } from 'commander'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { createProgram } from '../../src/cli/commands.js'
import { createServices } from '../../src/cli/runtime.js'
import { atomic } from '../../src/core/files.js'
import { Orchestrator } from '../../src/core/orchestrator.js'
import { initialState } from '../../src/core/state.js'
import { parseWorkflow } from '../../src/core/workflow.js'

const [root, mode, target = 'stdout'] = process.argv.slice(2)
if (!root || !mode) {
    throw new Error('isolated fixture root and mode required')
}
const services = createServices(root)
const write = target === 'stderr' ? services.error : services.output
const at = new Date('2026-10-23T03:00:00Z')
const workflow = parseWorkflow(await fs.readFile(new URL('./WORKFLOW.md', import.meta.url), 'utf8'))
workflow.vars.main = root
workflow.gates.start = 'auto'
workflow.steps.refine.on_ok = { set_stage: 'Issue更新済' }
const candidates = [1, 2].map((number) => ({
    number,
    title: `Issue ${number}`,
    state: 'open',
    assignees: ['me'],
    labels: [],
    createdAt: at.toISOString(),
    url: 'https://example.test/' + number,
}))
const stages = new Map(candidates.map((i) => [i.number, mode === 'approve' ? '再現済' : '未着手']))
const dir = (n) => path.join(root, 'issues', String(n))
for (const i of candidates) {
    await fs.mkdir(dir(i.number), { recursive: true })
}
let outputDuringAction = false
let observedBrokenDuringAction = false
async function checkpoint() {
    outputDuringAction = true
    write('途中の出力\n' + 'long output for pipe closure\n'.repeat(8192))
    await delay(30) // Let head exit and the asynchronous stream error arrive.
    observedBrokenDuringAction ||= services.outputSignal.aborted
}
const workspaces = []
const adapters = {
    tracker: {
        listCandidates: async () => candidates,
        getIssue: async (n) => candidates.find((i) => i.number === n),
        findPullRequests: async () => [],
    },
    stages: {
        get: async (n) => stages.get(n),
        ensure: async (n) => dir(n),
        dir: async (n) => dir(n),
        set: async (n, stage) => {
            stages.set(n, stage)
            await atomic(path.join(root, 'stages.json'), [...stages])
        },
    },
    workspace: {
        list: async () => workspaces,
        ensure: async (spec) => {
            const ws = { ...spec, workspaceId: `test-${spec.key}`, path: path.join(root, spec.key), slot: null }
            workspaces.push(ws)
            return ws
        },
        sync: async () => {},
        remove: async () => {},
    },
    runner: {
        list: async () => [],
        start: async (spec) => ({ runner: 'herdr', name: spec.name, paneId: 'test:p1' }),
        ready: async () => 'ready',
        status: async () => 'working',
        tail: async () => 'work',
        prompt: checkpoint,
        stop: async () => {},
        close: async () => {},
    },
    notifier: { notify: async () => {} },
    exec: {
        run: async (request) => {
            if (request.mutation) {
                await checkpoint()
                return ''
            }
            return 'main'
        },
    },
    remote: () => {
        throw new Error('remote adapter is forbidden')
    },
}
const o = new Orchestrator(workflow, adapters, root, false, services.output, () => at)
services.open = async () => o
if (mode === 'approve') {
    const state = {
        ...initialState(1, at.toISOString()),
        step: 'refine',
        status: 'waiting_gate',
        attempt: 1,
        base: 'main',
        locks: ['slot:1', 'db:shared'],
        gate: { name: 'issue_push', phase: 'after', summary: '承認', artifacts: [], since: at.toISOString() },
        pendingResult: { result: 'ok', summary: '完了', artifacts: [] },
    }
    await o.states.write(state)
    await o.locks.acquire(state.locks, 1, [])
} else if (!['tick', 'run'].includes(mode)) {
    for (const i of candidates) {
        await o.states.write(initialState(i.number, at.toISOString()))
    }
    await o.events.add(1, 'repro', 'fixture', '長いログ onClear clearable\n'.repeat(4096))
}
const args = {
    help: ['--help'],
    status: ['status', '1'],
    logs: ['logs', '1'],
    follow: ['logs', '1', '--follow'],
    tick: ['tick'],
    run: ['run', '--interval', '60'],
    approve: ['approve', '1', 'issue_push'],
}[mode]
if (!args) {
    throw new Error('unknown fixture mode')
}
// Help is small enough to fit in an OS pipe buffer. Also test rendering it
// after an already observed EPIPE; the real entry point is tested separately.
if (mode === 'help') {
    await checkpoint()
}
try {
    await createProgram(services).parseAsync(args, { from: 'user' })
} catch (error) {
    if (!(error instanceof CommanderError && error.exitCode === 0)) {
        throw error
    }
}
await delay(30) // Include errors from the last queued output, after parseAsync.
const states = []
for (const i of candidates) {
    const state = await o.states.read(i.number)
    if (state) {
        states.push({
            issue: state.issue,
            status: state.status,
            step: state.step,
            locks: state.locks,
            gate: state.gate?.name ?? null,
            effects: state.effects,
            inflight: state.inflight ?? null,
            completed: state.completed,
            approvals: state.approvals,
            history: state.history,
            pendingResult: state.pendingResult ?? null,
        })
    }
}
const registry = await o.locks.list()
await atomic(path.join(root, 'finished.json'), {
    outputDuringAction,
    observedBrokenDuringAction,
    closed: services.outputSignal.aborted,
    states,
    index: await o.states.numbers(),
    stages: [...stages],
    locks: { holders: registry.holders.map(({ resource, issue }) => ({ resource, issue })), waiters: registry.waiters },
    events: (await o.events.read()).map(({ issue, step, event, message }) => ({ issue, step, event, message })),
})
