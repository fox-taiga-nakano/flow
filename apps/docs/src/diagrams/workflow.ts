import type { Workflow } from '../../../../src/core/types.ts'
import { type Diagram, edge, node } from './model.ts'

const titles: Record<string, string> = {
    repro: '再現',
    refine: 'Issue 更新',
    implement: '修正',
    verify: '動作確認',
    finish: '仕上げ',
    cleanup: '片付け',
    complete: '段階を更新',
}

export function workflowDiagram(workflow: Workflow, overview = false): Diagram {
    const diagram: Diagram = {
        title: overview ? 'Issue から完了まで' : 'Gate と分岐の詳細',
        description: overview
            ? '上から順にたどれます。「要承認」の箇所では人の判断を待ちます。'
            : '同梱テンプレートの起動条件、Gate、検証結果による分岐。',
        presentation: overview ? 'sequence' : undefined,
        direction: 'DOWN',
        nodes: [
            node('detect', 'Issue の検出', 'process', 'GitHub の検索条件に一致する Issue を取得します。', {
                icon: 'github',
            }),
            node('review', '指定ユーザーにレビューを依頼', 'service', '関連 PR のレビュー依頼先を確認します。', {
                icon: 'github',
            }),
            node('merge', 'PR がマージ済み', 'service', '関連 PR のマージを GitHub から検出します。', {
                icon: 'github',
            }),
            node('end', '完了', 'process', 'PR がマージされ、Issue の段階を完了に更新した状態です。'),
            node(
                'failure',
                'エラー・停止',
                'process',
                '原因と残存する作業を確認。再試行可能な失敗は backoff を適用します。',
                { href: '/troubleshooting/' }
            ),
        ],
        edges: [],
    }
    if (overview) {
        diagram.nodes = diagram.nodes.filter(({ id }) => id !== 'failure')
    }
    const entries = Object.entries(workflow.steps)
    const byStage = new Map(
        entries.filter(([, step]) => step.when_stage).map(([name, step]) => [step.when_stage, name])
    )
    const first = (step: string) => (!overview && workflow.steps[step]!.gate_before ? `before:${step}` : `step:${step}`)
    for (const [name, step] of entries) {
        const id = `step:${name}`
        const kind = step.remote || step.agent ? 'agent' : 'process'
        const icon = step.remote ? 'copilot' : step.agent?.kind
        const tone = icon === 'claude' ? 'claude' : icon ? 'remote' : 'neutral'
        const details = [
            step.when_stage && `段階 ${step.when_stage} で開始。`,
            step.when_pr_review_requested && '指定ユーザーのいずれかにレビュー依頼が出たら開始。',
            step.when_pr_merged && 'PR マージ後に開始。',
            step.agent &&
                `${step.agent.kind} を ${step.workspace && step.workspace !== 'none' ? 'worktree' : 'メイン'} で起動。`,
            step.remote && 'GitHub 側の作業完了を監視。',
            step.action?.remove_workspaces && '所有 worktree を片付ける。',
            step.action?.command && '設定されたコマンドを実行。',
        ]
            .filter(Boolean)
            .join(' ')
        const badges: NonNullable<Diagram['nodes'][number]['badges']> = []
        for (const [phase, gateName] of [
            ['開始', step.gate_before],
            ['結果', step.gate_after],
        ] as const) {
            if (gateName) {
                const mode = workflow.gates[gateName]
                badges.push({
                    phase,
                    label: mode === 'manual' ? '要承認' : '自動',
                    gate: gateName,
                    tone: mode === 'manual' ? 'manual' : 'auto',
                })
            }
        }
        if (step.on_ng?.gate) {
            badges.push({ phase: 'NG 時', label: '対応を選択', gate: step.on_ng.gate, tone: 'ng' })
        } else if (step.on_ng?.stop) {
            badges.push({ phase: 'NG 時', label: '停止', tone: 'ng' })
        }
        const label = titles[name] ?? name
        diagram.nodes.push(
            node(id, !overview && label !== name ? `${label} · ${name}` : label, kind, details, {
                stepCode: overview ? name : undefined,
                badges: overview ? badges : undefined,
                tone,
                icon,
                href:
                    overview && badges.some(({ tone }) => tone === 'manual')
                        ? '/guides/approval/'
                        : '/concepts/workflow/',
            })
        )
        if (!overview && step.gate_before) {
            const mode = workflow.gates[step.gate_before]
            diagram.nodes.push(
                node(
                    first(name),
                    `${step.gate_before} · ${mode}`,
                    'gate',
                    mode === 'auto' ? '条件成立後に自動で進行。' : '承認を待ってから Step を起動。',
                    { href: '/guides/approval/' }
                )
            )
            diagram.edges.push(edge(first(name), id, mode === 'manual' ? '承認' : '自動'))
        }
        if (!overview && step.gate_after) {
            const gateId = `after:${name}`
            diagram.nodes.push(
                node(
                    gateId,
                    `${step.gate_after} · ${workflow.gates[step.gate_after]}`,
                    'gate',
                    '成果物を確認し、設定された承認後処理へ進みます。',
                    { href: '/guides/approval/' }
                )
            )
            diagram.edges.push(edge(id, gateId, '結果 OK'))
        }
        const after = !overview && step.gate_after ? `after:${name}` : id
        // The bundled issue push script sets Issue更新済. verify and finish rely on the agent-written stage.
        const nextStage =
            step.on_ok?.set_stage ??
            step.on_done?.set_stage ??
            (step.on_approve?.command === 'flow issue push {issue}' ? 'Issue更新済' : undefined)
        const next =
            byStage.get(nextStage) ??
            step.done_when?.stage_in?.map((stage) => byStage.get(stage)).find((target) => target && target !== name)
        if (next && next !== name) {
            diagram.edges.push(edge(after, first(next), overview ? undefined : (nextStage ?? '段階更新')))
        }
        if (step.when_pr_review_requested) {
            diagram.edges.push(edge('review', first(name)), edge(after, 'merge', overview ? undefined : 'マージ待ち'))
        }
        if (step.when_pr_merged) {
            diagram.edges.push(edge('merge', first(name)), edge(after, 'end'))
        }
        if (name === 'finish') {
            diagram.edges.push(edge(after, 'review', overview ? undefined : 'レビュー依頼待ち'))
        }
        if (!overview && step.on_ng?.gate) {
            const gateId = `ng:${name}`
            diagram.nodes.push(
                node(
                    gateId,
                    `${step.on_ng.gate} · ${workflow.gates[step.on_ng.gate]}`,
                    'gate',
                    'NG 結果への対応を決めます。',
                    { href: '/guides/approval/' }
                )
            )
            diagram.edges.push(edge(id, gateId, 'NG'), edge(gateId, 'failure', '停止'))
            const remoteStep = entries.find(([, candidate]) => candidate.remote)?.[0]
            if (step.on_ng.gate === 'ng_action' && workflow.remote?.ng_action && remoteStep !== undefined) {
                diagram.edges.push(edge(gateId, `step:${remoteStep}`, '修正依頼'))
            }
        }
        if (!overview && step.on_ng?.stop) {
            diagram.edges.push(edge(id, 'failure', 'NG'))
        }
    }
    const initial = byStage.get(workflow.stage_store.initial)
    if (initial) {
        diagram.edges.push(edge('detect', first(initial)))
    }
    return diagram
}
