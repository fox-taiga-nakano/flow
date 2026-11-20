/**
 * 表示の並び。段階の順に並べ、同じ段階の中は人の対応が要るもの（承認待ち・失敗）ほど下、Issue 番号の順。
 * dispatch の優先度は変えず、入力も変更しない。
 */
const urgency = (status: string | undefined): number =>
    ({ stopped: 0, done: 1, idle: 2, retry_wait: 2, waiting_remote: 3, running: 4, waiting_gate: 5, failed: 5 })[
        status ?? ''
    ] ?? 2
export function orderStages<T extends { stage: string | null; issue: number; status?: string }>(
    rows: T[],
    order: string[] = []
): T[] {
    const rank = new Map(order.map((name, index) => [name, index]))
    return [...rows].sort(
        (a, b) =>
            (rank.get(a.stage ?? '') ?? order.length) - (rank.get(b.stage ?? '') ?? order.length) ||
            urgency(a.status) - urgency(b.status) ||
            a.issue - b.issue
    )
}
