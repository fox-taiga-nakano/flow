import stringWidth from 'string-width'

import type { LaidOutDiagram, Point } from '../../../diagrams/model.ts'

type Box = Point & { width: number; height: number }
const intersects = (a: Box, b: Box) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

export function validateRoutes(diagram: LaidOutDiagram) {
    const positions = new Map<string, Box>()
    const cards: Box[] = []
    for (const node of diagram.nodes) {
        const parent = node.parent ? positions.get(node.parent) : undefined
        const bounds = { ...node, x: node.x + (parent?.x ?? 0), y: node.y + (parent?.y ?? 0) }
        positions.set(node.id, bounds)
        if (node.kind !== 'group') {
            cards.push(bounds)
        }
    }
    const labels: Box[] = []
    for (const edge of diagram.edges) {
        for (const line of edge.points) {
            for (let i = 1; i < line.length; i++) {
                const a = line[i - 1]!
                const b = line[i]!
                const width = Math.abs(b.x - a.x)
                const height = Math.abs(b.y - a.y)
                const segment = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width, height }
                if ((width > 0.01 && height > 0.01) || cards.some((card) => intersects(segment, card))) {
                    throw new Error(`${diagram.title}: 接続経路を確認してください (${edge.from} → ${edge.to})`)
                }
            }
        }
        if (edge.caption && edge.label) {
            const width = stringWidth(edge.label) * 6.5 + 8
            const label = { x: edge.caption.x - width / 2, y: edge.caption.y - 10, width, height: 20 }
            if ([...cards, ...labels].some((box) => intersects(label, box))) {
                throw new Error(`${diagram.title}: 接続ラベル「${edge.label}」の位置を確認してください`)
            }
            labels.push(label)
        }
    }
}
