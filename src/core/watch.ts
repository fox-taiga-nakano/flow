import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { Event } from './events.js'
import { atomic } from './files.js'

/** Events a person (or the operator agent) must look at; everything else is progress. */
export const ACTIONABLE = new Set(['action', 'error', 'warning', 'command_error', 'notifier_error', 'tick_error'])

/** Where reading stopped in each production log, keyed by `<date>/events.ndjson`. */
export type WatchCursor = Record<string, { identity: [number, number]; offset: number }>

function checkCursor(raw: unknown): WatchCursor {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('監視の読み取り位置が不正です')
    }
    for (const entry of Object.values(raw as Record<string, unknown>)) {
        const e = entry as { identity?: unknown; offset?: unknown }
        if (
            !e ||
            !Number.isSafeInteger(e.offset) ||
            (e.offset as number) < 0 ||
            !Array.isArray(e.identity) ||
            e.identity.length !== 2
        ) {
            throw new Error('監視の読み取り位置が不正です')
        }
    }
    return raw as WatchCursor
}

export async function readCursor(file: string): Promise<WatchCursor | null> {
    try {
        return checkCursor(JSON.parse(await fs.readFile(file, 'utf8')))
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            return null
        }
        throw e
    }
}
export const writeCursor = (file: string, cursor: WatchCursor) => atomic(file, cursor)

/**
 * Reads the production logs past the cursor. Only complete lines advance it, so a line being written
 * is read again next time; a replaced or truncated file is read from the start.
 * With `prime`, the cursor moves to the end without returning events.
 */
export async function scan(
    logs: string,
    cursor: WatchCursor,
    prime = false
): Promise<{ events: Event[]; cursor: WatchCursor }> {
    const updated: WatchCursor = { ...cursor }
    const events: Event[] = []
    const dates = await fs.readdir(logs).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') {
            return [] as string[]
        }
        throw e
    })
    for (const date of dates.sort()) {
        const key = `${date}/events.ndjson`
        const file = path.join(logs, key)
        let handle
        try {
            handle = await fs.open(file, 'r')
        } catch (e) {
            if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) {
                continue
            }
            throw e
        }
        try {
            const stat = await handle.stat()
            const identity: [number, number] = [stat.dev, stat.ino]
            const previous = cursor[key]
            let offset =
                previous && previous.identity[0] === identity[0] && previous.identity[1] === identity[1]
                    ? previous.offset
                    : 0
            if (offset > stat.size) {
                offset = 0
            }
            const rest = Buffer.alloc(stat.size - offset)
            if (rest.length) {
                await handle.read(rest, 0, rest.length, offset)
            }
            let start = 0
            for (let end = rest.indexOf(10); end >= 0; start = end + 1, end = rest.indexOf(10, start)) {
                const line = rest.subarray(start, end)
                const at = offset + end + 1
                if (prime) {
                    continue
                }
                let row: unknown
                try {
                    row = JSON.parse(line.toString('utf8'))
                } catch (e) {
                    throw new Error(`${file}:${at}: ${String(e)}`)
                }
                if (!row || typeof row !== 'object' || Array.isArray(row)) {
                    throw new Error(`${file}:${at}: イベントが不正です`)
                }
                const event = row as Event
                if (ACTIONABLE.has(event.event) && !event.dryRun) {
                    events.push(event)
                }
            }
            updated[key] = { identity, offset: offset + start }
        } finally {
            await handle.close()
        }
    }
    return { events, cursor: updated }
}
