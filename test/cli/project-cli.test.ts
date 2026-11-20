import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vite-plus/test'

const dirs: string[] = []
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
it('selects the project independently of the installed CLI and current directory', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-project-'))
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-other-'))
    dirs.push(project, other)
    fs.mkdirSync(path.join(project, '.flow'))
    fs.copyFileSync(path.resolve('test/fixtures/WORKFLOW.md'), path.join(project, '.flow/WORKFLOW.md'))
    const cli = path.resolve('dist/main.mjs')
    expect(execFileSync(process.execPath, [cli, 'validate'], { cwd: project, encoding: 'utf8' })).toContain('valid')
    expect(
        execFileSync(process.execPath, [cli, '--project', project, 'validate'], { cwd: other, encoding: 'utf8' })
    ).toContain('valid')
    expect(() => execFileSync(process.execPath, [cli, 'validate'], { cwd: other, stdio: 'pipe' })).toThrow()
})
