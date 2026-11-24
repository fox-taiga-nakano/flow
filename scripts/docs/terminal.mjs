import { stripVTControlCharacters } from 'node:util'

import { createProgram } from '../../src/cli/commands.ts'
import { Output } from '../../src/cli/output.ts'
import { changedFields, runFrame } from '../../src/cli/run-frame.ts'
import { gateAnswer } from '../../src/core/orchestrator.ts'
import { FlowPaths } from '../../src/core/paths.ts'

const now = Date.parse('2026-10-20T01:24:08Z')
const base = { issue: 123, title: '設定画面に表示名を追加', slot: null, agent: null, gate: null, elapsed: 0 }

// All adapters are fixtures. The normal executable, Herdr and GitHub are never called.
export async function terminal(workflow, interval) {
    const view = new Output({ isTTY: true, columns: 104, env: { TERM: 'xterm-256color' } })
    const stage = workflow.steps.repro.when_stage
    const gate = workflow.steps.repro.gate_before
    if (!gate || workflow.gates[gate] !== 'manual') {
        throw new Error('デモの承認シナリオをテンプレートの開始 gate に合わせてください')
    }
    const approve = gateAnswer(base.issue, gate, 'before')
    const waiting = { ...base, stage, step: 'repro', status: 'waiting_gate', gate, answer: approve }
    const running = {
        ...base,
        stage,
        step: 'repro',
        status: 'running',
        slot: workflow.locks.slots[0],
        agent: workflow.steps.repro.agent.name.replaceAll('{issue}', String(base.issue)),
        elapsed: 83,
    }
    const remote = {
        ...base,
        issue: 124,
        stage: workflow.steps.implement.when_stage,
        step: 'implement',
        status: 'waiting_remote',
        elapsed: 63,
    }
    const done = { ...base, issue: 125, stage: '完了', step: 'cleanup', status: 'done', elapsed: 240 }
    const failed = { ...running, status: 'failed', error: 'エージェントの結果ファイルがありません' }
    const rows = [done, remote, waiting]
    const model = {
        rows,
        notices: [],
        changed: new Map(),
        ticking: false,
        stopped: false,
        interval,
        at: now,
        next: now + interval * 1000,
        timezone: workflow.timezone,
        rejected: workflow.stage_store.rejected,
    }
    const paths = new FlowPaths('/flow-docs-fixture-does-not-exist/.flow')
    const dir = `/demo/issues/7-${stage}_123`
    const logs = [
        {
            at: new Date(now).toISOString(),
            issue: base.issue,
            step: 'repro',
            event: 'action',
            message: `承認待ち: ${gate}: repro を開始してよいか確認してください\n成果物: ${dir}\n${approve}`,
        },
    ]
    async function execute(args) {
        const lines = []
        await createProgram({
            paths,
            view,
            output: (line) => lines.push(line),
            error: (line) => lines.push(line),
            open: async () => ({
                workflow,
                tick: async () => [{ ...running, planned: true }],
                control: async () => {},
                states: { numbers: async () => rows.map((r) => r.issue), read: async () => ({}) },
                rows: async () => rows,
                a: {
                    tracker: { listCandidates: async () => [] },
                    stages: { get: async () => stage, dir: async () => dir },
                },
                events: { read: async () => logs },
            }),
        })
            .exitOverride()
            .parseAsync(args, { from: 'user' })
        return lines.join('\n')
    }
    const frame = (patch, time = now) => runFrame({ ...model, ...patch }, view, time)
    const advanced = [done, remote, running]
    const notification = view.notification({
        issue: base.issue,
        title: `承認待ち: ${gate}`,
        level: 'action',
        body: logs[0].message,
        gate: {
            name: gate,
            summary: 'repro を開始してよいか確認してください',
            artifacts: [dir],
            command: approve,
            issueDir: dir,
        },
    })
    const scenes = [
        { id: 'initial', label: '初回起動', command: 'flow run', ansi: frame({ at: undefined, ticking: true }) },
        { id: 'ticking', label: 'tick 実行中', command: 'flow run', ansi: frame({ ticking: true }) },
        {
            id: 'running',
            label: 'エージェント実行中',
            command: 'flow run',
            ansi: frame({ rows: advanced }, now + 17000),
        },
        { id: 'waiting', label: '承認待ち', command: 'flow run', ansi: frame({}) },
        { id: 'notice', label: '承認通知', command: 'flow run', ansi: frame({ notices: [notification] }) },
        {
            id: 'approved',
            label: '承認後',
            command: 'flow run',
            ansi: frame({ rows: advanced, changed: changedFields(rows, advanced) }),
        },
        { id: 'complete', label: '処理完了', command: 'flow run', ansi: frame({ rows: [done] }, now + 27000) },
        {
            id: 'error',
            label: 'エラー',
            command: 'flow run',
            ansi: frame({
                rows: [done, remote, failed],
                changed: changedFields(advanced, [done, remote, failed]),
                notices: [view.tone('Error: GitHub の情報を取得できませんでした', 'error')],
            }),
        },
        { id: 'stopped', label: '停止', command: 'flow run', ansi: frame({ rows: advanced, stopped: true }) },
        { id: 'status', label: '状態一覧', command: 'flow status', ansi: await execute(['status']) },
        { id: 'logs', label: 'イベントログ', command: 'flow logs 123', ansi: await execute(['logs', '123']) },
        { id: 'dry', label: '実行予定', command: 'flow tick --dry-run', ansi: await execute(['tick', '--dry-run']) },
    ]
    const approval = { command: approve, ansi: await execute(approve.split(' ').slice(1)) }
    return { scenes, approval }
}

export const plainOutput = stripVTControlCharacters
