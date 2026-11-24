import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { layoutArchitecture } from '../../apps/docs/src/components/diagrams/layout/architecture.ts'
import { layout } from '../../apps/docs/src/components/diagrams/layout/elk.ts'
import { diagrams } from '../../apps/docs/src/diagrams/index.ts'
import { parseWorkflow } from '../../src/core/workflow.ts'
import { commands } from './cli.mjs'
import { configModel } from './config.mjs'
import { configReferences, generated, references } from './reference.mjs'
import { terminal } from './terminal.mjs'

const check = process.argv.includes('--check')
const root = fileURLToPath(new URL('../../', import.meta.url))
const app = 'apps/docs/src'
const content = `${app}/content/docs/reference`
const read = (file) =>
    readFile(path.join(root, file), 'utf8').catch((error) => {
        if (error.code === 'ENOENT') {
            return undefined
        }
        throw error
    })
const json = (value) => JSON.stringify(value, null, 2) + '\n'
const workflow = parseWorkflow(await read('templates/WORKFLOW.md'))
const cli = commands()
const config = configModel(workflow)
const interval = cli
    .find((command) => command.id === 'run')
    ?.options.find((option) => option.id === '--interval')?.default
if (!Number.isFinite(interval) || interval <= 0) {
    throw new Error('run --interval の既定値を端末デモに反映してください')
}
const demo = await terminal(workflow, interval)
const models = diagrams(workflow)
const stateIds = [
    ...new Set(
        [...models.state.nodes, ...models.stateRecovery.nodes].map(({ id }) => id).filter((id) => id !== 'stage')
    ),
].sort()
if (JSON.stringify(stateIds) !== JSON.stringify(config.statuses.toSorted())) {
    throw new Error('state-machine.ts: Status に合わせてノードと遷移を更新してください')
}
const diagramsLaidOut = {}
for (const [id, model] of Object.entries(models)) {
    diagramsLaidOut[id] = id === 'architecture' ? layoutArchitecture(model) : await layout(model)
}

const { version } = JSON.parse(await read('package.json'))
const files = new Map([
    [`${app}/generated/cli.json`, json(cli)],
    [`${app}/generated/config.json`, json(config)],
    [`${app}/generated/diagrams.json`, json(diagramsLaidOut)],
    [`${app}/generated/terminal.json`, json(demo)],
    [`${app}/generated/version.json`, json({ version })],
    ...references(cli, demo).map(([file, data]) => [`${content}/cli/${file}`, data]),
    ...configReferences(config).map(([file, data]) => [`${content}/${file}`, data]),
])
const stale = []
for (const [file, data] of files) {
    if ((await read(file)) === data) {
        continue
    }
    if (check) {
        stale.push(file)
    } else {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true })
        await writeFile(path.join(root, file), data)
    }
}
for (const file of await readdir(path.join(root, content), { recursive: true })) {
    const full = `${content}/${file}`
    if (files.has(full) || !file.endsWith('.md')) {
        continue
    }
    if (!(await read(full))?.includes(generated)) {
        continue
    }
    if (check) {
        stale.push(`${full} (削除対象)`)
    } else {
        await rm(path.join(root, full))
    }
}
if (stale.length) {
    console.error('生成データに差分があります。pnpm docs:generate を実行してください。\n' + stale.join('\n'))
    process.exitCode = 1
} else {
    console.log(
        `${files.size} ファイル、${cli.length} コマンド、${Object.keys(models).length} 図、${demo.scenes.length} 端末スナップショットを${check ? '検証' : '生成'}しました。`
    )
}
