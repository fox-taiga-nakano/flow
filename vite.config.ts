import { defineConfig } from 'vite-plus'

export default defineConfig({
    pack: {
        entry: ['src/cli/main.ts'],
        outDir: 'dist',
        format: 'esm',
        outExtensions: () => ({ js: '.mjs' }),
        deps: {
            alwaysBundle: [/.*/],
            onlyBundle: [
                'ansi-regex',
                'cli-table3',
                'commander',
                'emoji-regex',
                'get-east-asian-width',
                'is-fullwidth-code-point',
                'picocolors',
                'string-width',
                'strip-ansi',
                'yaml',
            ],
            onlyImport: [],
        },
    },
    lint: {
        plugins: ['eslint', 'typescript', 'react', 'oxc', 'unicorn', 'import'],
        options: {
            typeAware: true,
            typeCheck: true,
        },
        env: {
            browser: true,
        },
        rules: {
            'react/rules-of-hooks': 'error',
            'react/exhaustive-deps': 'error',
            'react/react-in-jsx-scope': 'off',
            'typescript/consistent-type-imports': 'error',
            // import 文の並びは fmt.sortImports に任せ、{ } 内の並びだけ検査・自動修正する
            'sort-imports': ['error', { ignoreCase: true, ignoreDeclarationSort: true }],
            'typescript/no-explicit-any': 'warn',
            curly: ['error', 'all'],
        },
    },
    test: {
        include: ['test/**/*.test.ts'],
        // These tests exercise fsync/rename and child processes.
        fileParallelism: false,
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
    fmt: {
        semi: false,
        singleQuote: true,
        printWidth: 120,
        tabWidth: 4,
        trailingComma: 'es5',
        bracketSameLine: false,
        singleAttributePerLine: false,
        sortTailwindcss: {
            functions: ['cn', 'cva'],
            attributes: ['tw'],
        },
        overrides: [
            {
                files: ['**/*.{yml,yaml,css,md,mdx}'],
                options: { tabWidth: 2 },
            },
        ],
        sortImports: {
            newlinesBetween: true,
            sortSideEffects: true,
            customGroups: [
                {
                    groupName: 'react',
                    elementNamePattern: ['react', 'react/**', 'react-*', 'react-*/**'],
                },
                {
                    groupName: 'next',
                    elementNamePattern: ['next', 'next/**', 'next-*', 'next-*/**'],
                },
                {
                    groupName: 'lib',
                    elementNamePattern: ['@/lib', '@/lib/**'],
                },
                {
                    groupName: 'metadata',
                    elementNamePattern: ['@/metadata', '@/metadata/**'],
                },
                {
                    groupName: 'const',
                    elementNamePattern: ['@/const', '@/const/**'],
                },
                {
                    groupName: 'app',
                    elementNamePattern: [
                        '@/providers',
                        '@/providers/**',
                        '@/atoms',
                        '@/atoms/**',
                        '@/hooks',
                        '@/hooks/**',
                        '@/contexts',
                        '@/contexts/**',
                        '@/components',
                        '@/components/**',
                        '@/svg',
                        '@/svg/**',
                        '@/pages',
                        '@/pages/**',
                        '@/interfaces',
                        '@/interfaces/**',
                        '@/app',
                        '@/app/**',
                        // apps/catalog の @/*
                        '@/comparisons',
                        '@/comparisons/**',
                        '@/previews',
                        '@/previews/**',
                        '@/data',
                        '@/registry-api',
                        '@/registry-meta',
                    ],
                },
                {
                    groupName: 'styles',
                    elementNamePattern: ['@/styles', '@/styles/**', '**/*.css'],
                },
            ],
            groups: [
                'react',
                'next',
                ['builtin', 'external', 'unknown'],
                'internal',
                'lib',
                'metadata',
                'const',
                'app',
                'styles',
                ['parent', 'sibling', 'index'],
            ],
        },
    },
})
