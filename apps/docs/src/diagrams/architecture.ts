import { type Diagram, edge, node } from './model.ts'

// Sources: README.md, the bundled skills and template, and src/adapters/{github,herdr,copilot}.ts.
export const architecture: Diagram = {
    title: 'システム構成',
    description: 'flow を使った開発環境の構成例です。メイン側の操作と、Issue ごとの作業環境を Herdr で管理します。',
    direction: 'RIGHT',
    presentation: 'architecture',
    nodes: [
        node('user', 'あなた', 'service', '端末から運用を依頼し、提示された Gate を判断します。', {
            tone: 'human',
            subtitle: '作業者',
            href: '/guides/approval/',
        }),
        node(
            'herdr',
            'herdr：ペインと worktree を束ねるターミナル',
            'group',
            'メインと worktree の workspace を管理。'
        ),
        node('main', 'メイン（リポジトリ本体）', 'group', 'プロジェクトのメインチェックアウト。', { parent: 'herdr' }),
        node('skills', 'skills', 'service', '同梱またはプロジェクトが定義したスキルを Claude Code に渡します。', {
            parent: 'main',
            icon: 'file',
            subtitle: 'Claude が読む手順書',
        }),
        node(
            'main-agent',
            'Claude Code',
            'agent',
            '同梱の flow-operator スキルを使う場合、メイン側のエージェントが run・watch を使って運用を補助します。',
            {
                parent: 'main',
                tone: 'claude',
                icon: 'claude',
                subtitle: 'メイン：指示・監視・報告',
            }
        ),
        node('flow', 'flow', 'process', '各 tick で候補を取得し、段階・Gate・所有情報を照合します。', {
            parent: 'main',
            icon: 'terminal',
            subtitle: 'Issue の段階を進める',
            href: '/reference/cli/',
        }),
        node(
            'worktree',
            'worktree（Issue・PR ごとの作業場所）',
            'group',
            '専用 workspace にエージェント用のタブとペインを用意します。',
            {
                parent: 'herdr',
                subtitle: 'slot ごとに dev のポートを分け、複数の Issue を並行で処理できます。',
            }
        ),
        node('dev', 'dev サーバー', 'service', 'プロジェクトの作業手順に従って起動します。', {
            parent: 'worktree',
            icon: 'server',
            subtitle: 'プロジェクトの開発環境',
            href: '/reference/worktree/',
        }),
        node('tools', '外部ツール', 'service', 'スキルやプロンプトで指定するツール。開発環境に応じて選択します。', {
            parent: 'worktree',
            icon: 'terminal',
            subtitle: '画面操作やテスト',
        }),
        node(
            'claude',
            'Claude Code',
            'agent',
            '同梱テンプレートのローカルエージェント。Step のプロンプトを受け取ります。',
            {
                parent: 'worktree',
                tone: 'claude',
                icon: 'claude',
                subtitle: 'Step：再現・検証・仕上げ',
            }
        ),
        node('codex', 'Codex', 'agent', 'agent.kind を codex にした Step で起動できるローカルエージェント。', {
            parent: 'worktree',
            tone: 'remote',
            icon: 'codex',
            subtitle: '設定で選べるエージェント',
        }),
        node('github', 'GitHub', 'service', 'gh から Issue・PR を取得し、設定に従って変更します。', {
            icon: 'github',
            subtitle: 'Issue・PR',
        }),
        node('copilot', 'GitHub Copilot', 'agent', 'remote Step を受け取り、GitHub 側で関連 PR を作業します。', {
            tone: 'remote',
            icon: 'copilot',
            subtitle: '修正して PR を作成',
        }),
        node(
            'data',
            'ローカルの記録',
            'service',
            '共有台帳は .flow、Issue ごとの状態は Issue ディレクトリに保存します。',
            {
                icon: 'disk',
                subtitle: '状態・ログ・ロック',
                href: '/reference/runtime/',
            }
        ),
    ],
    edges: [
        edge('user', 'main-agent', '依頼・承認'),
        edge('main-agent', 'user', '報告'),
        edge('main-agent', 'flow', 'run・watch・approve'),
        edge('flow', 'github', '取得・割当'),
        edge('github', 'copilot', '修正を依頼'),
        edge('flow', 'claude', '作成・起動'),
        edge('flow', 'codex', '設定で起動'),
        edge('claude', 'dev', '起動'),
        edge('codex', 'tools', '必要に応じ利用'),
        edge('flow', 'data', '保存・参照'),
    ],
}
