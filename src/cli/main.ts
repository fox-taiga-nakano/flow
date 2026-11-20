#!/usr/bin/env node
import { CommanderError } from 'commander'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createProgram } from './commands.js'
import { createServices } from './runtime.js'
import { packageRoot, selfPath } from './tools.js'

// Global options must precede the subcommand. Commander validates the option itself.
const args = process.argv.slice(2)
let project = process.cwd()
for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--project') {
        if (args[i + 1] && !args[i + 1]!.startsWith('-')) {
            project = args[++i]!
        }
    } else if (arg.startsWith('--project=')) {
        project = arg.slice('--project='.length) || project
    } else if (!arg.startsWith('-')) {
        break
    }
}
const root = path.join(path.resolve(project), '.flow')
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    // Commands that flow runs (WORKFLOW.md, tools/) call `flow` itself: this package on this Node.
    try {
        const bundle = packageRoot()
        process.env.PATH = selfPath(process.env, bundle)
        // A frequent read can call a bundled script directly, without starting Node again.
        process.env.FLOW_TOOLS = path.join(bundle, 'tools')
    } catch {
        /* Without tools/ (a broken install), commands still run; `flow issue|wt` reports the missing directory. */
    }
    const services = createServices(root)
    const program = createProgram(services)
    let active = program
    program.hook('preAction', (_root, command) => {
        active = command
    })
    program.parseAsync(process.argv).catch((error) => {
        if (error instanceof CommanderError) {
            process.exitCode = error.exitCode === 0 ? 0 : 1
        } else {
            services.error(`引数または実行のエラー: ${error instanceof Error ? error.message : String(error)}`)
            active.outputHelp({ error: true })
            process.exitCode = 1
        }
    })
}
