import type { Workflow } from '../../../../src/core/types.ts'
import { type Diagram, edge, node } from './model.ts'

export function stateMachine(workflow: Workflow) {
    const startConditions = Object.entries(workflow.steps).map(([name, step]) => {
        const trigger = step.when_stage ?? 'PR マージ後'
        const gate = step.gate_before
        return `${trigger} → ${name}${gate ? `（${gate}: ${workflow.gates[gate]}）` : ''}`
    })
    const all: Diagram = {
        title: '実行状態',
        description: '',
        direction: 'DOWN',
        nodes: [
            node(
                'stage',
                'Stage を読む',
                'service',
                `起動条件に合う Step を選びます。テンプレートの条件は ${startConditions.join('、')} です。`,
                { icon: 'folder' }
            ),
            node('idle', 'idle', 'process', '次の tick で開始・再開判定。'),
            node('waiting_gate', 'waiting_gate', 'gate', 'manual は人の判断待ち。auto は条件を満たすと進行します。', {
                href: '/guides/approval/',
            }),
            node('running', 'running', 'agent', 'ローカルのエージェントが作業中。', { tone: 'claude' }),
            node('waiting_remote', 'waiting_remote', 'agent', 'Copilot の完了条件を PR から確認中。', {
                tone: 'remote',
            }),
            node('done', 'done', 'process', 'Step が終了。次に処理可能な段階または完了を確認します。'),
            node('retry_wait', 'retry_wait', 'process', 'バックオフ経過後に再試行。'),
            node('failed', 'failed', 'process', '試行上限や継続できないエラー。'),
            node('stopped', 'stopped', 'process', '手動停止・対象外・保留など。停止理由を確認して復旧します。', {
                href: '/guides/recovery/',
            }),
        ],
        edges: [
            edge('stage', 'idle', '起動条件'),
            edge('idle', 'waiting_gate', 'manual'),
            edge('idle', 'running', 'auto / Gate なし'),
            edge('waiting_gate', 'running', '開始承認後'),
            edge('idle', 'waiting_remote', '割当後'),
            edge('waiting_remote', 'done', 'PR が条件を満たす'),
            edge('running', 'waiting_gate', '結果・質問・復旧'),
            edge('running', 'done', '正常終了'),
            edge('waiting_gate', 'done', '結果承認後'),
            edge('running', 'retry_wait', '再試行可能'),
            edge('retry_wait', 'idle', '待機後'),
            edge('running', 'failed', '失敗'),
            edge('waiting_gate', 'stopped', '停止・却下'),
            edge('running', 'stopped', '停止'),
            edge('failed', 'idle', '手動 retry'),
            edge('stopped', 'idle', '手動 retry'),
        ],
    }
    const recoveryStates = new Set(['retry_wait', 'failed', 'stopped'])
    function view(recovery: boolean): Diagram {
        const edges = all.edges.filter(
            ({ from, to }) => (recoveryStates.has(from) || recoveryStates.has(to)) === recovery
        )
        const visible = new Set(edges.flatMap(({ from, to }) => [from, to]))
        return {
            ...all,
            title: recovery ? '停止と再試行' : '開始から完了までの実行状態',
            description: recovery
                ? '停止や失敗から待機に戻る条件です。'
                : 'Stage を読んでから、ローカル作業・リモート作業・Gate のいずれかへ進みます。完了後は次の tick で Stage を読み直します。',
            nodes: all.nodes.filter(({ id }) => visible.has(id)),
            edges,
        }
    }
    return { progress: view(false), recovery: view(true) }
}
