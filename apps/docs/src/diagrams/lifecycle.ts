import { type Diagram, edge, node } from './model.ts'

export const lifecycle: Diagram = {
    title: 'ローカル Step の実行ライフサイクル',
    description: 'エージェントを使う Step の代表経路。remote や action の Step では別の完了条件を使います。',
    direction: 'DOWN',
    nodes: [
        node('select', '起動条件と上限', 'process', 'Stage で Step を選び、同時実行数を確認。'),
        node('before', '開始 Gate', 'gate', 'manual なら承認を待ちます。'),
        node('prepare', '起動準備', 'process', '必要な worktree と slot・資源ロックを確保。'),
        node('agent', '起動・指示送信', 'agent', 'Herdr ペインを用意し、ガードと Step の指示を送信。', {
            tone: 'claude',
            icon: 'terminal',
        }),
        node('result', '結果ファイル・成果物', 'process', '試行番号に応じた結果と done_when の条件を照合。'),
        node('after', '結果 Gate', 'gate', '設定に従って承認を待ち、承認後コマンドや継続指示を適用。'),
        node('next', '完了・次の Step', 'process', '完了を保存し、次の tick で段階を確認。'),
        node('retry', '失敗・再試行', 'process', 'エラーとペインを確認。回復できる場合は再試行へ。', {
            href: '/guides/recovery/',
        }),
    ],
    edges: [
        edge('select', 'before'),
        edge('before', 'prepare', '開始可能'),
        edge('prepare', 'agent'),
        edge('agent', 'result'),
        edge('result', 'after', 'OK'),
        edge('after', 'next', '完了条件成立'),
        edge('result', 'retry', '失敗'),
        edge('retry', 'select', '再試行'),
    ],
}
