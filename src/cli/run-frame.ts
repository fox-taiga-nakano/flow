import type { StatusRow } from '../core/orchestrator.js'
import type { ChangedField, IssueLink, Output } from './output.js'

/** What `flow run` shows, kept apart from fetching so any change can redraw it. */
export type RunModel = {
    rows: StatusRow[]
    link?: IssueLink
    rejected?: string
    timezone?: string
    /** What the last tick printed: notices, dry-run SKIPPED lines, warnings and errors. */
    notices: string[]
    changed: Map<number, Set<ChangedField>>
    /** When the last tick finished (ms). */
    at?: number
    /** When the next tick starts (ms); absent while a tick runs or after the loop stopped. */
    next?: number
    ticking: boolean
    stopped: boolean
    interval: number
}

const fields: ChangedField[] = ['stage', 'step', 'status', 'gate']
/** Cells a tick changed; the first tick marks nothing, an Issue new to the table marks every field. */
export function changedFields(before: StatusRow[] | undefined, after: StatusRow[]): Map<number, Set<ChangedField>> {
    const changed = new Map<number, Set<ChangedField>>()
    if (!before) {
        return changed
    }
    const previous = new Map(before.map((r) => [r.issue, r]))
    for (const row of after) {
        const old = previous.get(row.issue)
        const set = new Set(fields.filter((f) => !old || old[f] !== row[f]))
        if (set.size) {
            changed.set(row.issue, set)
        }
    }
    return changed
}

export function runFrame(model: RunModel, view: Output, now: number): string {
    const last =
        model.at === undefined ? undefined : `最終 tick: ${view.time(new Date(model.at).toISOString(), model.timezone)}`
    const state = model.ticking
        ? [last, 'tick 実行中…']
        : model.stopped
          ? [last, 'flow run は停止しました']
          : [
                last,
                `次回まで ${Math.max(0, Math.ceil(((model.next ?? now) - now) / 1000))} 秒（${model.interval} 秒ごと。Ctrl+C で終了）`,
            ]
    return [
        ...model.notices,
        ...(model.at === undefined
            ? []
            : [
                  view.status(model.rows, model.rejected, model.link, model.changed),
                  view.answers(model.rows, model.link),
              ]),
        view.prose(state.filter(Boolean).join(' ・ '), 'muted'),
    ].join('\n')
}
