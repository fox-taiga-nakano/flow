import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { CommandError } from '../core/command-error.js'
import type { Exec, ExecRequest } from '../core/types.js'

const execute = promisify(execFile)
export class ShellExec implements Exec {
    readonly planned: ExecRequest[] = []
    constructor(
        readonly dryRun = false,
        readonly output = console.log
    ) {}
    async run(r: ExecRequest): Promise<string> {
        if (r.mutation && this.dryRun) {
            this.planned.push(r)
            this.output(`[dry-run MUTATION SKIPPED] cwd=${r.cwd ?? '.'} ${r.command}`)
            return ''
        }
        try {
            const { stdout } = await execute('/bin/bash', ['-c', r.command], {
                cwd: r.cwd,
                maxBuffer: 32 * 1024 * 1024,
                timeout: r.timeoutMs ?? 600_000,
            })
            return stdout.trimEnd()
        } catch (e) {
            throw new CommandError(r.command, e as Error)
        }
    }
}
