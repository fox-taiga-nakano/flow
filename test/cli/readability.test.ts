import { promises as fs } from 'node:fs'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import stringWidth from 'string-width'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { createProgram } from '../../src/cli/commands.js'
import { elapsedTime, pathTail, relativeArtifacts, wrapText } from '../../src/cli/display-text.js'
import { Output } from '../../src/cli/output.js'
import { type CliServices, showStatus, table } from '../../src/cli/runtime.js'
import type { Event } from '../../src/core/events.js'
import { atomic } from '../../src/core/files.js'
import type { StatusRow } from '../../src/core/orchestrator.js'
import { orderStages } from '../../src/core/stage-order.js'
import { harness, workflowFixture } from '../helpers.js'

const dirs: string[] = []
afterEach(async () => {
    vi.restoreAllMocks()
    for (const dir of dirs.splice(0)) {
        await fs.rm(dir, { recursive: true, force: true })
    }
})
const view = (columns = 120, tty = false) => new Output({ columns, isTTY: tty, env: {} })
const row = (issue: number, stage: string | null = '未着手'): StatusRow => ({
    issue,
    stage,
    title: '表示',
    step: 'repro',
    status: 'waiting_gate',
    gate: 'start',
    agent: null,
    slot: null,
    elapsed: 162461,
})
const at = '2026-10-23T01:02:03Z'
const dir = '/project with spaces/.dev/issues/7-未着手_2261'
const location = { dir, issue: 2261, pattern: '^\\d+-(.+)_\\d+$' }
const event: Event = {
    at,
    issue: 2261,
    step: 'repro',
    event: 'action',
    message: `成果物: ${dir}/evidence/before/checks.tsv\n再現手順を確認してください。`,
}

describe('compact tables and elapsed time', () => {
    it('has only the header separator for 14 Issue rows', () => {
        const text = view().status(Array.from({ length: 14 }, (_, i) => row(i + 1)))
        expect(text.split('\n').filter((line) => line.startsWith('├'))).toHaveLength(1)
        expect(text.split('\n')).toHaveLength(18)
        expect(text).toContain('1日21時間')
        expect(text).not.toContain('162461')
    })
    it.each([
        [0, '0秒'],
        [45, '45秒'],
        [59, '59秒'],
        [60, '1分'],
        [12 * 60 + 59, '12分'],
        [3600, '1時間'],
        [3 * 3600 + 5 * 60 + 59, '3時間5分'],
        [86400, '1日'],
        [162461, '1日21時間'],
        [-1, '0秒'],
    ] as const)('formats %i seconds as %s', (seconds, text) => {
        expect(elapsedTime(seconds)).toBe(text)
    })
    it('does not mutate elapsed seconds while rendering a row', () => {
        const input = row(1)
        view().status([input])
        expect(input.elapsed).toBe(162461)
    })
})

describe('lossless logs and readable paths', () => {
    it.each([24, 40, 80, 120])('wraps full contents, whitespace and grapheme clusters at %i cells', (columns) => {
        const source = '  日本語👩‍💻か\u3099の説明  ' + '/very/long/path/evidence/screenshot.png'.repeat(4)
        const wrapped = wrapText(source, columns, '  ')
        for (const line of wrapped.split('\n')) {
            expect(stringWidth(line)).toBeLessThanOrEqual(columns)
        }
        expect(
            wrapped
                .split('\n')
                .map((line) => line.slice(2))
                .join('')
        ).toBe(source)
        expect(wrapped).not.toContain('…')
    })
    it.each([false, true])('renders full unframed log contents for TTY=%s', (tty) => {
        const v = view(40, tty)
        const text = stripVTControlCharacters(v.logs([event], 'Asia/Tokyo', new Map([[2261, location]])))
        const lines = text.split('\n')
        expect(text).not.toMatch(/[┌│└]/u)
        expect(text).not.toContain('…')
        expect(text).not.toContain(dir)
        expect(
            lines
                .filter((line) => line.startsWith('  '))
                .map((line) => line.slice(2))
                .join('')
        ).toBe('成果物: evidence/before/checks.tsv再現手順を確認してください。')
        for (const line of lines) {
            expect(stringWidth(line)).toBeLessThanOrEqual(40)
        }
    })
    it('retains unknown Issue paths in full instead of hiding the log on directory lookup failure', () => {
        const text = view(40).logs([event])
        const contents = text
            .split('\n')
            .filter((line) => line.startsWith('  '))
            .map((line) => line.slice(2))
            .join('')
        expect(contents).toContain(dir + '/evidence/before/checks.tsv')
        expect(contents).not.toContain('…')
    })
    it('relativizes current/former stage directories, multiple paths and roots, leaving other Issues alone', () => {
        const text = `成果物: ${dir}/repro.md, /project with spaces/.dev/issues/6-再現済_2261/scripts/repro.sh\n${dir}\n/project with spaces/.dev/issues/7-未着手_9/repro.md`
        expect(relativeArtifacts(text, location)).toBe(
            '成果物: repro.md, scripts/repro.sh\n.\n/project with spaces/.dev/issues/7-未着手_9/repro.md'
        )
    })
    it("keeps a long workspace path's tail, and a long basename's extension", () => {
        const input = '/home/user/projects/.herdr/worktrees/example-app/flow-repro-2261'
        expect(pathTail(input, 45)).toBe('…/worktrees/example-app/flow-repro-2261')
        expect(pathTail(input, 17)).toBe('…/flow-repro-2261')
        expect(pathTail('/path/非常に長いファイル名のスクリーンショット.png', 16)).toMatch(/\.png$/)
        expect(stringWidth(pathTail(input, 12))).toBeLessThanOrEqual(12)
    })
    it('applies tail truncation after lock column widths have been allocated', () => {
        const text = view(120).locks({
            holders: [
                {
                    resource: 'db:exclusive',
                    issue: 2261,
                    pid: 42,
                    since: at,
                    workspace: '/home/user/' + 'very-long-parent/'.repeat(8) + 'flow-repro-2261',
                },
            ],
            waiters: [],
        })
        expect(text).toContain('flow-repro-2261')
        expect(text).not.toContain('flow-r…')
        expect(text.split('\n').filter((line) => line.startsWith('├'))).toHaveLength(1)
    })
    it('displays gate artifacts relative to the Issue directory', () => {
        const text = view().notification({
            issue: 2261,
            title: '確認',
            body: '',
            level: 'action',
            gate: {
                name: 'repro_result',
                summary: '再現を確認',
                artifacts: [dir + '/scripts/repro.sh', dir + '/repro.md'],
                command: 'flow approve 2261 repro_result',
                issueDir: dir,
            },
        })
        expect(text).toContain('scripts/repro.sh')
        expect(text).toContain('repro.md')
        expect(text).not.toContain(dir)
    })
})

describe('configured stage order', () => {
    it('sorts custom names, ties, unlisted stages and missing stages without mutating input', () => {
        const input = [row(9, 'unknown'), row(4, null), row(7, 'later'), row(5, 'first'), row(1, 'first')]
        expect(orderStages(input, ['first', 'later']).map((r) => r.issue)).toEqual([1, 5, 7, 4, 9])
        expect(input.map((r) => r.issue)).toEqual([9, 4, 7, 5, 1])
        expect(orderStages(input, ['later', 'first']).map((r) => r.issue)).toEqual([7, 1, 5, 4, 9])
    })
    it('uses configured order for table/previous plan without changing stored row values', () => {
        const output = vi.fn()
        const input = [row(1, 'later'), row(2, 'first')]
        table(input, output, view(), 'rejected', ['first', 'later'])
        const text = output.mock.calls[0]![0] as string
        expect(text.indexOf('#2')).toBeLessThan(text.indexOf('#1'))
        expect(input[0]?.elapsed).toBe(162461)
    })
    it('orders registered and unregistered status rows identically for text and JSON, retaining seconds', async () => {
        const h = await harness({ count: 4 })
        dirs.push(h.dir)
        h.workflow.gates.start = 'manual'
        await h.o.tick()
        h.stages.set(1, '未着手')
        h.stages.set(2, '対象外')
        h.stages.set(3, '検証済')
        h.stages.set(4, '検証済')
        await fs.rm(path.join(h.files.get(4)!, 'flow/state.json'))
        h.advance(162461000)
        await atomic(h.o.paths.plan, [row(1, '未着手'), row(2, '対象外'), row(3, '検証済')])
        const output = vi.fn()
        await showStatus(h.o, h.o.paths, undefined, true, output, view())
        const rows = JSON.parse(output.mock.calls[0]![0] as string) as StatusRow[]
        // 段階の順。同じ段階の中は対応の要るもの（承認待ち）ほど下
        expect(rows.map((r) => r.issue)).toEqual([2, 4, 3, 1])
        expect(rows.filter((r) => r.issue !== 4).every((r) => r.elapsed === 162461)).toBe(true)
        expect(rows.find((r) => r.issue === 4)?.status).toBe('未登録')
        output.mockClear()
        await showStatus(h.o, h.o.paths, undefined, false, output, view())
        for (const [text] of output.mock.calls.filter(([text]) => String(text).includes('┌'))) {
            expect(String(text).indexOf('#2')).toBeLessThan(String(text).indexOf('#1'))
        }
        const services: CliServices = {
            paths: h.o.paths,
            open: async () => h.o,
            output,
            error: vi.fn(),
            view: view(),
            now: () => 0,
            sleep: async () => {},
        }
        h.o.tick = vi.fn(async () => [row(1, '未着手'), row(2, '対象外')])
        output.mockClear()
        await createProgram(services).parseAsync(['tick', '--dry-run'], { from: 'user' })
        expect(String(output.mock.calls[0]![0]).indexOf('#2')).toBeLessThan(
            String(output.mock.calls[0]![0]).indexOf('#1')
        )
    })
    it.each([
        { order: [] },
        { order: ['対象外', '対象外'] },
        { order: [''] },
        { order: [' 未着手'] },
        { order: [123] },
        { order: '対象外' },
        { order: ['対象外', '../完了'] },
    ])('rejects invalid stage names/settings: $order', async ({ order }) => {
        const workflow = await workflowFixture()
        expect(() =>
            workflow((raw) => {
                raw.stage_store.order = order
            })
        ).toThrow('stage_store.order')
    })
    it('keeps order optional for older workflows, and supports a different valid order', async () => {
        const workflow = await workflowFixture()
        expect(
            workflow((raw) => {
                delete raw.stage_store.order
            }).stage_store.order
        ).toBeUndefined()
        expect(
            workflow((raw) => {
                raw.stage_store.order = ['対象外', '完了']
            }).stage_store.order
        ).toEqual(['対象外', '完了'])
        const reordered = workflow((raw) => {
            raw.stage_store.order = ['未着手', '再現済', 'Issue更新済', '修正中', '検証NG', '検証済', '完了', '対象外']
        })
        expect(reordered.stage_store.order?.[0]).toBe('未着手')
    })
})
