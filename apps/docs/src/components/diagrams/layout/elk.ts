import type { ElkNode } from 'elkjs/lib/elk-api'
import ELK from 'elkjs/lib/elk.bundled.js'

import type { Diagram, LaidOutDiagram, PlacedNode, Point } from '../../../diagrams/model.ts'
import { validateRoutes } from './validate-routes.ts'

export function validateDiagram(diagram: Diagram) {
    const nodes = new Map(diagram.nodes.map((node) => [node.id, node]))
    if (nodes.size !== diagram.nodes.length) {
        throw new Error(`${diagram.title}: ノード ID が重複しています`)
    }
    for (const node of nodes.values()) {
        const ancestors = new Set([node.id])
        for (let parent = node.parent; parent; parent = nodes.get(parent)?.parent) {
            if (ancestors.has(parent) || nodes.get(parent)?.kind !== 'group') {
                throw new Error(`${diagram.title}: 無効な親関係 ${node.id} → ${parent}`)
            }
            ancestors.add(parent)
        }
    }
    const edges = new Set()
    for (const { from, to } of diagram.edges) {
        const key = JSON.stringify([from, to])
        if (!nodes.has(from) || !nodes.has(to) || from === to || edges.has(key)) {
            throw new Error(`${diagram.title}: 無効な接続 ${from} → ${to}`)
        }
        edges.add(key)
    }
}

export async function layout(diagram: Diagram): Promise<LaidOutDiagram> {
    validateDiagram(diagram)
    const sequence = diagram.presentation === 'sequence'
    const childNodes = (parent?: string): ElkNode[] =>
        diagram.nodes
            .filter((node) => node.parent === parent)
            .map((node) =>
                node.kind === 'group'
                    ? {
                          id: node.id,
                          children: childNodes(node.id),
                          layoutOptions: { 'elk.padding': '[top=46,left=24,bottom=24,right=24]' },
                      }
                    : {
                          id: node.id,
                          width: sequence ? 228 : 198,
                          height: sequence ? (node.badges?.some(({ tone }) => tone === 'manual') ? 56 : 40) : 68,
                      }
            )
    const result: ElkNode = await new ELK().layout({
        id: 'root',
        layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': diagram.direction,
            'elk.edgeRouting': 'ORTHOGONAL',
            'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
            'elk.padding': '[top=24,left=24,bottom=24,right=24]',
            'elk.spacing.nodeNode': '32',
            'elk.spacing.edgeNode': '24',
            'elk.spacing.edgeLabel': '8',
            'elk.layered.spacing.nodeNodeBetweenLayers': sequence ? '24' : '45',
            'elk.layered.spacing.edgeNodeBetweenLayers': '26',
            'elk.layered.edgeLabels.sideSelection': 'SMART',
            'elk.layered.cycleBreaking.strategy': 'GREEDY_MODEL_ORDER',
        },
        children: childNodes(),
        edges: diagram.edges.map(({ from, to, label, labelPlacement }, index) => ({
            id: `edge-${index}`,
            sources: [from],
            targets: [to],
            labels: label
                ? [
                      {
                          text: label,
                          width: label.length * 13 + 16,
                          height: 22,
                          layoutOptions: { 'elk.edgeLabels.placement': labelPlacement ?? 'TAIL' },
                      },
                  ]
                : [],
        })),
    })
    const placed: PlacedNode[] = []
    const offsets = new Map<string, Point>()
    function read(current: ElkNode, origin: Point) {
        const { id, x = 0, y = 0, width = 0, height = 0 } = current
        offsets.set(id, { x: x + origin.x, y: y + origin.y })
        if (id !== 'root') {
            const node = diagram.nodes.find((candidate) => candidate.id === id)!
            placed.push({ ...node, x, y, width, height })
        }
        current.children?.forEach((child) => read(child, offsets.get(id)!))
    }
    read(result, { x: 0, y: 0 })
    const edges = (result.edges ?? []).map((route, index) => {
        const offset = offsets.get((route as typeof route & { container?: string }).container ?? 'root')!
        const absolute = ({ x, y }: Point) => ({ x: x + offset.x, y: y + offset.y })
        const points = (route.sections ?? []).map((section) =>
            [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(absolute)
        )
        if (!points.length) {
            throw new Error(`${diagram.title}: 経路を配置できません: ${route.id}`)
        }
        const label = route.labels?.[0]
        const caption = label && absolute({ x: label.x! + label.width! / 2, y: label.y! + label.height! / 2 })
        return { ...diagram.edges[index]!, id: route.id, points, caption }
    })
    const nodes = sequence ? placed.toSorted((a, b) => a.y - b.y || a.x - b.x) : placed
    const routed = { ...diagram, nodes, edges }
    validateRoutes(routed)
    return routed
}
