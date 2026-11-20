import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export async function atomic(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
    try {
        const fd = await fs.open(tmp, 'wx', 0o600)
        try {
            await fd.writeFile(JSON.stringify(value, null, 2) + '\n')
            await fd.sync()
        } finally {
            await fd.close()
        }
        await fs.rename(tmp, file)
    } finally {
        await fs.rm(tmp, { force: true })
    }
}
export async function json<T>(file: string): Promise<T | null> {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8')) as T
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            return null
        }
        throw e
    }
}
export const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0)
        return true
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
}
export async function exists(file: string): Promise<boolean> {
    try {
        await fs.access(file)
        return true
    } catch {
        return false
    }
}
export function artifact(dir: string, file: string): string {
    const resolved = path.resolve(dir, file)
    if (resolved !== path.resolve(dir) && !resolved.startsWith(path.resolve(dir) + path.sep)) {
        throw new Error(`成果物は Issue ディレクトリ内にしてください: ${file}`)
    }
    return resolved
}
// A short-lived cross-process mutex. A dead owner may be recovered; a live owner is never evicted by age.
export async function mutex<T>(file: string, fn: () => Promise<T>, wait = false): Promise<T> {
    await fs.mkdir(path.dirname(file), { recursive: true })
    for (;;) {
        try {
            const fd = await fs.open(file, 'wx', 0o600)
            await fd.writeFile(String(process.pid))
            await fd.close()
            break
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw e
            }
            const raw = await fs.readFile(file, 'utf8').catch(() => '')
            const pid = Number(raw)
            if (pid > 0 && !alive(pid)) {
                await fs.rm(file, { force: true })
                continue
            }
            if (!wait) {
                throw new Error(`別プロセスが実行中: ${file}`)
            }
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
    }
    try {
        return await fn()
    } finally {
        await fs.rm(file, { force: true })
    }
}
