import cloudflare from '@astrojs/cloudflare'
import react from '@astrojs/react'
import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

export default defineConfig({
    site: 'https://flow.tagiadoc.workers.dev',
    devToolbar: { enabled: false },
    integrations: [
        react(),
        starlight({
            title: 'flow',
            description: 'GitHub Issue の作業と人の承認を管理する CLI',
            defaultLocale: 'root',
            locales: { root: { label: '日本語', lang: 'ja' } },
            customCss: ['./src/styles/site.css'],
            social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/fox-taiga-nakano/flow/' }],
            editLink: { baseUrl: 'https://github.com/fox-taiga-nakano/flow/edit/main/apps/docs/' },
            sidebar: [
                { label: 'はじめに', items: [{ label: 'flow について', slug: '' }] },
                { label: '導入', items: ['getting-started/install', 'getting-started/quickstart'] },
                {
                    label: '使い方',
                    items: [
                        'guides/issue-to-merge',
                        'guides/run',
                        'guides/approval',
                        'guides/worktrees',
                        'guides/recovery',
                        'guides/update',
                    ],
                },
                {
                    label: '仕組み',
                    items: [
                        'concepts/architecture',
                        { label: 'Workflow と状態遷移', slug: 'concepts/workflow' },
                        { label: '実行のしくみとロック', slug: 'concepts/execution' },
                    ],
                },
                {
                    label: 'リファレンス',
                    items: [
                        {
                            label: 'CLI コマンド',
                            collapsed: true,
                            items: [{ autogenerate: { directory: 'reference/cli', collapsed: true } }],
                        },
                        'reference/workflow',
                        'reference/workflow-schema',
                        'reference/worktree',
                        'reference/worktree-schema',
                        { label: '実行時ファイルと環境変数', slug: 'reference/runtime' },
                    ],
                },
                { label: 'トラブルシューティング', items: ['troubleshooting'] },
                { label: '開発・メンテナンス', items: ['contributing/maintenance'] },
            ],
        }),
    ],
    adapter: cloudflare({ prerenderEnvironment: 'node' }),
})
