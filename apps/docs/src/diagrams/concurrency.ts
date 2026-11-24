import type { Workflow } from '../../../../src/core/types.ts'
import { type Diagram, edge, node } from './model.ts'

export function concurrency(workflow: Workflow): Diagram {
    return {
        title: '複数 Issue の実行',
        description:
            'Issue ごとに作業ブランチとエージェントを分離します。段階や Step によってはメインで作業し、worktree を使わない場合もあります。',
        direction: 'RIGHT',
        nodes: [
            node(
                'tick',
                'flow tick',
                'process',
                `例の全体上限は ${workflow.concurrency.global}。Step 別上限も適用します。`,
                { icon: 'terminal' }
            ),
            node(
                'locks',
                '資源ロック',
                'service',
                `例の slot は ${workflow.locks.slots.join('・')}。共有・排他ロックは locks.resources で設定します。`,
                { icon: 'lock', href: '/reference/cli/lock/' }
            ),
            ...[123, 124].flatMap((issue, index) => [
                node(`wt:${issue}`, `Issue #${issue} の workspace`, 'group', 'Herdr worktree の作業領域。'),
                node(
                    `branch:${issue}`,
                    `worktree · slot ${workflow.locks.slots[index] ?? '—'}`,
                    'service',
                    'Issue 別の作業ブランチと開発ポートを使います。',
                    { parent: `wt:${issue}`, icon: 'folder', href: '/reference/worktree/' }
                ),
                node(`agent:${issue}`, 'agent タブ', 'agent', '専用ペインに所有エージェントを起動します。', {
                    parent: `wt:${issue}`,
                    tone: 'claude',
                    icon: 'terminal',
                }),
            ]),
        ],
        edges: [
            edge('tick', 'locks', '取得・解放'),
            ...[123, 124].flatMap((issue) => [
                edge('locks', `branch:${issue}`, 'slot 割当'),
                edge(`branch:${issue}`, `agent:${issue}`, '専用ペイン'),
            ]),
        ],
    }
}
