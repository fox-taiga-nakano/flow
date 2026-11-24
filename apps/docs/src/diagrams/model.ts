export type Kind = 'service' | 'agent' | 'process' | 'gate' | 'group'
export type Tone = 'human' | 'claude' | 'remote' | 'neutral'
export type Icon =
    | 'person'
    | 'terminal'
    | 'github'
    | 'copilot'
    | 'claude'
    | 'codex'
    | 'folder'
    | 'file'
    | 'disk'
    | 'server'
    | 'lock'

export interface DiagramNode {
    id: string
    label: string
    detail: string
    kind: Kind
    tone?: Tone
    icon?: Icon
    parent?: string
    href?: string
    subtitle?: string
    stepCode?: string
    badges?: { phase: string; label: string; gate?: string; tone: 'manual' | 'auto' | 'ng' }[]
}

export interface DiagramEdge {
    from: string
    to: string
    label?: string
    labelPlacement?: 'HEAD' | 'TAIL'
}

export interface Diagram {
    title: string
    description: string
    direction: 'RIGHT' | 'DOWN'
    presentation?: 'sequence' | 'architecture'
    nodes: DiagramNode[]
    edges: DiagramEdge[]
}

export type Point = { x: number; y: number }
export type PlacedNode = DiagramNode & Point & { width: number; height: number }
export type RoutedEdge = DiagramEdge & { id: string; points: Point[][]; caption?: Point }
export type LaidOutDiagram = Omit<Diagram, 'nodes' | 'edges'> & {
    nodes: PlacedNode[]
    edges: RoutedEdge[]
}

export const node = (
    id: string,
    label: string,
    kind: Kind,
    detail: string,
    extra: Partial<Omit<DiagramNode, 'id' | 'label' | 'kind' | 'detail'>> = {}
): DiagramNode => ({ id, label, kind, detail, ...extra })

export const edge = (
    from: string,
    to: string,
    label?: string,
    labelPlacement?: DiagramEdge['labelPlacement']
): DiagramEdge => ({ from, to, label, labelPlacement })
