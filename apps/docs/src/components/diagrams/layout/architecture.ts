import type { Diagram, LaidOutDiagram, PlacedNode, RoutedEdge } from '../../../diagrams/model.ts'
import { validateDiagram } from './elk.ts'
import { validateRoutes } from './validate-routes.ts'

type Rect = [left: number, top: number, width: number, height: number]
type Coordinate = [x: number, y: number]

// Fix the workspace boundaries and communication corridors shown in the architecture diagram.
// Coordinates are relative to the canvas so the paths and their captions share the same grid.
const boxes: Record<string, Rect> = {
    user: [20, 186, 148, 68],
    herdr: [228, 18, 646, 452],
    main: [246, 68, 184, 381],
    skills: [262, 110, 152, 56],
    'main-agent': [262, 186, 152, 68],
    flow: [262, 348, 152, 64],
    worktree: [490, 68, 365, 381],
    dev: [507, 186, 147, 68],
    tools: [691, 186, 147, 68],
    claude: [507, 348, 147, 64],
    codex: [691, 348, 147, 64],
    github: [20, 348, 148, 64],
    copilot: [20, 449, 148, 62],
    data: [925, 348, 155, 64],
}

const corridors: Record<string, { route: Coordinate[]; caption: Coordinate }> = {
    'user:main-agent': {
        route: [
            [168, 207],
            [262, 207],
        ],
        caption: [216, 192],
    },
    'main-agent:user': {
        route: [
            [262, 232],
            [168, 232],
        ],
        caption: [216, 247],
    },
    'main-agent:flow': {
        route: [
            [338, 254],
            [338, 348],
        ],
        caption: [408, 301],
    },
    'flow:github': {
        route: [
            [262, 380],
            [168, 380],
        ],
        caption: [215, 365],
    },
    'github:copilot': {
        route: [
            [94, 412],
            [94, 449],
        ],
        caption: [136, 430],
    },
    'flow:claude': {
        route: [
            [414, 380],
            [507, 380],
        ],
        caption: [461, 365],
    },
    'flow:codex': {
        route: [
            [384, 412],
            [384, 429],
            [765, 429],
            [765, 412],
        ],
        caption: [582, 430],
    },
    'claude:dev': {
        route: [
            [581, 348],
            [581, 254],
        ],
        caption: [600, 300],
    },
    'codex:tools': {
        route: [
            [765, 348],
            [765, 254],
        ],
        caption: [817, 300],
    },
    'flow:data': {
        route: [
            [338, 412],
            [338, 487],
            [1003, 487],
            [1003, 412],
        ],
        caption: [916, 473],
    },
}

const point = ([x, y]: Coordinate) => ({ x, y })

export function layoutArchitecture(diagram: Diagram): LaidOutDiagram {
    validateDiagram(diagram)
    const getBox = (id: string) => {
        const box = boxes[id]
        if (!box) {
            throw new Error(`システム構成: ${id} の配置がありません`)
        }
        return box
    }
    const nodes: PlacedNode[] = diagram.nodes.map((node) => {
        const [left, top, width, height] = getBox(node.id)
        const [parentX, parentY, parentW, parentH] = node.parent ? getBox(node.parent) : [0, 0, Infinity, Infinity]
        const x = left - parentX
        const y = top - parentY
        if (x < 0 || y < 0 || x + width > parentW || y + height > parentH) {
            throw new Error(`システム構成: ${node.id} がグループの枠からはみ出しています`)
        }
        return { ...node, x, y, width, height }
    })
    const edges: RoutedEdge[] = diagram.edges.map((edge) => {
        const id = `${edge.from}:${edge.to}`
        const corridor = corridors[id]
        if (!corridor) {
            throw new Error(`システム構成: ${id} の接続経路がありません`)
        }
        return { ...edge, id, points: [corridor.route.map(point)], caption: point(corridor.caption) }
    })
    const result = { ...diagram, nodes, edges }
    validateRoutes(result)
    return result
}
