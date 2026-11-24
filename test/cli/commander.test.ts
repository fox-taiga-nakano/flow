import { CommanderError } from 'commander'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vite-plus/test'

import { createProgram } from '../../src/cli/commands.js'
import type { CliServices } from '../../src/cli/runtime.js'
import type { Orchestrator } from '../../src/core/orchestrator.js'
import { FlowPaths } from '../../src/core/paths.js'
import { temp } from '../helpers.js'

async function fixture() {
    const root = await temp()
    const o = {
        tick: vi.fn(async () => []),
        control: vi.fn(async () => {}),
        acquireResource: vi.fn(async () => true),
        releaseResource: vi.fn(async () => {}),
        locks: {
            validate: vi.fn(),
            queue: vi.fn(async () => {}),
            cancel: vi.fn(async () => {}),
            list: vi.fn(async () => ({ holders: [], waiters: [] })),
        },
        a: { tracker: { listCandidates: vi.fn(async () => []) }, stages: { get: vi.fn(async () => null) } },
        workflow: { steps: {}, stage_store: { initial: '未着手' } },
        states: { numbers: vi.fn(async () => []) },
        rows: vi.fn(async () => []),
        events: { read: vi.fn(async () => []), add: vi.fn(async () => {}) },
    }
    const services: CliServices = {
        paths: new FlowPaths(root),
        open: vi.fn(async () => o as unknown as Orchestrator),
        output: vi.fn(),
        error: vi.fn(),
        sleep: vi.fn(async () => {}),
        now: vi.fn(() => 0),
    }
    const program = createProgram(services)
    return { root, o, services, program, run: (args: string[]) => program.parseAsync(args, { from: 'user' }) }
}

it('uses native Commander commands, including a default status command and implicit help', async () => {
    const f = await fixture()
    expect(f.program.commands.find((c) => c.name() === 'lock')?.commands.map((c) => c.name())).toEqual([
        'acquire',
        'release',
        'list',
    ])
    expect(f.program.commands.some((c) => c.name() === 'help')).toBe(false)
    await f.run([])
    expect(f.o.a.tracker.listCandidates).toHaveBeenCalledOnce()
    expect(f.services.open).toHaveBeenCalledWith(false, true, false)
    const json = await fixture()
    await json.run(['--json'])
    expect(json.services.output).toHaveBeenCalledWith('[]')
})
it('tick uses the parsed dry-run flag directly', async () => {
    const f = await fixture()
    await f.run(['tick', '--dry-run'])
    expect(f.services.open).toHaveBeenCalledExactlyOnceWith(true)
    expect(f.o.tick).toHaveBeenCalledOnce()
    expect(f.services.output).toHaveBeenCalledWith(expect.stringContaining('SKIPPED'))
})
it.each([[], ['--interval', '2.5']])(
    'run uses native defaults/numbers and Ctrl+C leaves agents alone: %j',
    async (...args: string[]) => {
        const f = await fixture()
        f.o.tick.mockImplementationOnce(async () => {
            process.emit('SIGINT')
            return []
        })
        await f.run(['run', '--dry-run', ...args])
        expect(f.program.commands.find((c) => c.name() === 'run')?.opts().interval).toBe(args.length ? 2.5 : 60)
        expect(f.o.tick).toHaveBeenCalledOnce()
        expect(f.services.open).toHaveBeenCalledWith(true)
        await expect(fs.access(f.services.paths.flowPid)).rejects.toThrow()
    }
)
it('run keeps one frame in place on a terminal, and only appends otherwise', async () => {
    const live = await fixture()
    const order: string[] = []
    const render = vi.fn((text: string) => void order.push(text.includes('tick 実行中') ? 'ticking' : 'frame'))
    const close = vi.fn(() => void order.push('close'))
    const capture = vi.fn(() => vi.fn())
    const stopResize = vi.fn()
    live.services.live = {
        render,
        invalidate: vi.fn(),
        capture,
        onResize: vi.fn(() => stopResize),
        close,
    }
    const row = {
        issue: 4004,
        title: '',
        stage: '検証済',
        step: 'cleanup',
        status: 'waiting_gate',
        agent: null,
        slot: null,
        elapsed: 0,
    }
    live.o.tick.mockImplementationOnce(async () => {
        order.push('tick')
        process.emit('SIGINT')
        return [
            { ...row, gate: 'cleanup', answer: 'flow approve 4004 cleanup' },
            { ...row, issue: 2260, status: 'running', gate: null },
        ] as never
    })
    await live.run(['run', '--dry-run'])
    // The previous frame is never erased before a tick: the tick only changes the last line.
    expect(order).toEqual(['ticking', 'tick', 'frame', 'close'])
    expect(capture).toHaveBeenCalledOnce()
    expect(stopResize).toHaveBeenCalledOnce()
    const frame = render.mock.calls.at(-1)![0]
    expect(frame).toContain('承認待ち（1 件）')
    expect(frame).toContain('flow approve 4004 cleanup')
    expect(frame).toContain('最終 tick: 1970-01-01 09:00:00 ・ flow run は停止しました')
    expect(live.services.output).not.toHaveBeenCalled()
    const piped = await fixture()
    piped.o.tick.mockImplementationOnce(async () => {
        process.emit('SIGINT')
        return []
    })
    await piped.run(['run', '--dry-run'])
    expect(vi.mocked(piped.services.output).mock.calls.flat().join('\n')).not.toContain('最終 tick')
})
it.each([
    [
        ['approve', '3620', 'base_changed', '--choice', 'keep'],
        3620,
        'approve',
        { gate: 'base_changed', choice: 'keep' },
    ],
    [['reject', '3953', 'start', '--reason', '対象外'], 3953, 'reject', { gate: 'start', reason: '対象外' }],
    [['retry', '3953'], 3953, 'retry', undefined],
    [['stop', '3953', '--reason', '確認'], 3953, 'stop', { reason: '確認' }],
] as const)('control action receives a numeric Issue and native choices: %j', async (args, issue, mode, options) => {
    const f = await fixture()
    await f.run([...args])
    if (options) {
        expect(f.o.control).toHaveBeenCalledExactlyOnceWith(issue, mode, options)
    } else {
        expect(f.o.control).toHaveBeenCalledExactlyOnceWith(issue, mode)
    }
})
it('status receives a numeric Issue and prints JSON', async () => {
    const f = await fixture()
    await f.run(['status', '3170', '--json'])
    expect(f.services.output).toHaveBeenCalledWith(expect.stringContaining('"details": null'))
    expect(f.services.open).toHaveBeenCalledWith(false, true, false)
})
it('lock actions use required numeric options, defaults and resource methods', async () => {
    const acquire = await fixture()
    await acquire.run(['lock', 'acquire', 'db:exclusive', '--issue', '3953', '--wait'])
    expect(acquire.o.acquireResource).toHaveBeenCalledExactlyOnceWith('db:exclusive', 3953)
    expect(acquire.o.locks.queue).toHaveBeenCalledExactlyOnceWith('db:exclusive', 3953)
    expect(acquire.o.locks.cancel).toHaveBeenCalledExactlyOnceWith('db:exclusive', 3953)
    expect(acquire.program.commands.find((c) => c.name() === 'lock')?.commands[0]?.opts().timeout).toBe(0)
    const release = await fixture()
    await release.run(['lock', 'release', 'db:exclusive', '--issue', '3953'])
    expect(release.o.releaseResource).toHaveBeenCalledExactlyOnceWith('db:exclusive', 3953)
    const list = await fixture()
    await list.run(['lock', 'list'])
    expect(list.o.locks.list).toHaveBeenCalledOnce()
})
it('lock wait respects its parsed timeout and always cancels the waiter', async () => {
    const f = await fixture()
    f.o.acquireResource.mockResolvedValue(false)
    vi.mocked(f.services.now).mockReturnValueOnce(0).mockReturnValue(250)
    await expect(f.run(['lock', 'acquire', 'db:shared', '--issue', '1', '--wait', '--timeout', '200'])).rejects.toThrow(
        'lock を取得できません'
    )
    expect(f.o.locks.cancel).toHaveBeenCalledExactlyOnceWith('db:shared', 1)
})
it.each([
    [[], { days: 1 }],
    [['--days', '3'], { days: 3 }],
    [['--days', '3.0'], { days: 3 }],
    [['--date', '2026-10-21'], { date: '2026-10-21' }],
] as const)('logs reads the selected dates without reparsing: %j', async (args, selection) => {
    const f = await fixture()
    await f.run(['logs', '3953', ...args])
    expect(f.o.events.read).toHaveBeenCalledExactlyOnceWith(3953, selection)
})
it.each(['-f', '--follow'])('logs %s follows events', async (flag) => {
    const f = await fixture()
    vi.mocked(f.services.sleep).mockRejectedValueOnce(new Error('テスト終了'))
    await expect(f.run(['logs', flag])).rejects.toThrow('テスト終了')
    expect(f.services.sleep).toHaveBeenCalledExactlyOnceWith(500)
})
it('validate disables the fallback configuration', async () => {
    const f = await fixture()
    await f.run(['validate'])
    expect(f.services.open).toHaveBeenCalledExactlyOnceWith(false, false, false)
})
it.each([
    [['--dry-run', 'tick'], 'dryRun', true],
    [['--interval', '5', 'run', '--dry-run'], 'interval', 5],
    [['--issue', '3953', 'lock', 'acquire', 'db:shared'], 'issue', 3953],
] as const)('preserves options before the command using native option values: %j', async (args, key, value) => {
    const f = await fixture()
    f.o.tick.mockImplementationOnce(async () => {
        if (args.some((arg) => arg === 'run')) {
            process.emit('SIGINT')
        }
        return []
    })
    await f.run([...args])
    expect(f.program.getOptionValue(key)).toBe(value)
    if (key === 'issue') {
        expect(f.o.acquireResource).toHaveBeenCalledWith('db:shared', 3953)
    }
})
it.each([
    ['wat'],
    ['tick', 'extra'],
    ['status', 'oops'],
    ['approve'],
    ['retry', '1', 'extra'],
    ['lock', 'wat'],
    ['tick', '--choice', 'keep'],
    ['run', '--interval', 'bad'],
    ['approve', '1', '--choice', 'wat'],
    ['logs', '--f'],
    ['logs', '--days', '1.5'],
    ['lock', 'acquire', 'db:shared', '--issue', '0'],
    ['--choice', 'keep', 'tick'],
])('rejects malformed arguments before opening adapters: %j', async (...args) => {
    const f = await fixture()
    await expect(f.run(args)).rejects.toBeInstanceOf(CommanderError)
    expect(f.services.open).not.toHaveBeenCalled()
    expect(f.services.error).toHaveBeenCalledWith(expect.stringContaining('引数または実行のエラー:'))
})

it.each([[], ['--json']])('numeric shorthand preserves status 3170: %j', async (...options: string[]) => {
    const f = await fixture()
    await f.run(['3170', ...options])
    expect(f.services.open).toHaveBeenCalledExactlyOnceWith(false, true, false)
    expect(f.o.a.stages.get).toHaveBeenCalledExactlyOnceWith(3170)
    expect(f.services.output).not.toHaveBeenCalledWith(expect.stringContaining('TypeError'))
    const explicit = await fixture()
    await explicit.run(['status', '3170', ...options])
    expect(vi.mocked(f.services.output).mock.calls).toEqual(vi.mocked(explicit.services.output).mock.calls)
})

it('run は tick 中の起床要求を完了直後に処理する', async () => {
    const f = await fixture()
    f.o.tick.mockImplementationOnce(async () => {
        await fs.writeFile(f.services.paths.wake, '')
        return []
    })
    f.o.tick.mockImplementationOnce(async () => {
        process.emit('SIGINT')
        return []
    })
    await f.run(['run', '--interval', '60'])
    expect(f.o.tick).toHaveBeenCalledTimes(2)
})

it('approve は flow run が動いているときだけ起床要求を残す', async () => {
    const f = await fixture()
    await f.run(['approve', '3170'])
    await expect(fs.access(f.services.paths.wake)).rejects.toThrow()
    await fs.mkdir(path.dirname(f.services.paths.flowPid), { recursive: true })
    await fs.writeFile(f.services.paths.flowPid, '1')
    await f.run(['approve', '3170'])
    await expect(fs.access(f.services.paths.wake)).resolves.toBeUndefined()
})
