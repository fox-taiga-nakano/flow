import { type KeyboardEvent, useId, useMemo, useRef, useState } from 'react'

import { MarkerType, ReactFlow, type ReactFlowInstance } from '@xyflow/react'

import './styles/diagram.css'
import '@xyflow/react/dist/style.css'

import type { LaidOutDiagram, PlacedNode } from '../../diagrams/model'
import { type FlowEdge, OrthogonalEdge } from './edges/OrthogonalEdge'
import { DiagramCard, DiagramGroup, type FlowNode } from './nodes/DiagramNode'

const nodeTypes = { card: DiagramCard, group: DiagramGroup }
const edgeTypes = { orthogonal: OrthogonalEdge }
const fit = { padding: 0.14, minZoom: 0.12, maxZoom: 1 }

function showArchitectureRegion(
    instance: ReactFlowInstance<FlowNode, FlowEdge> | null,
    viewport: HTMLDivElement | null,
    id: string
) {
    const node = instance?.getNode(id)
    if (!instance || !node || !viewport) {
        return
    }
    const box = instance.getNodesBounds([node])
    const { clientWidth: width, clientHeight: height } = viewport
    const zoom = Math.max(0.82, Math.min(1, (width - 30) / box.width))
    const visibleWidth = (width - 30) / zoom
    void instance.setCenter(box.x + Math.min(box.width, visibleWidth) / 2, box.y + (height / 2 - 16) / zoom, { zoom })
}

function resetView(
    instance: ReactFlowInstance<FlowNode, FlowEdge>,
    viewport: HTMLDivElement | null,
    sequence: boolean
) {
    if (!viewport) {
        return
    }
    const { clientWidth: width, clientHeight: height } = viewport
    const bounds = instance.getNodesBounds(instance.getNodes().filter((node) => !node.parentId))
    const showAll = !sequence && bounds.height < 1400
    const widthZoom = (width - 36) / bounds.width
    const heightZoom = (height - 36) / bounds.height
    const zoom = showAll ? Math.min(1, widthZoom, heightZoom) : Math.min(1, Math.max(sequence ? 0.3 : 0.69, widthZoom))
    const x = Math.max(18, (width - bounds.width * zoom) / 2) - bounds.x * zoom
    const y = (showAll ? Math.max(18, (height - bounds.height * zoom) / 2) : 20) - bounds.y * zoom
    void instance.setViewport({ x, y, zoom })
}

function DiagramDetails({ selected, sequence }: { selected?: PlacedNode; sequence: boolean }) {
    return (
        <div className="diagram-detail" aria-live="polite">
            {selected ? (
                <>
                    <strong>{selected.label}</strong>
                    {selected.stepCode && <code className="diagram-detail-code">{selected.stepCode}</code>}
                    <p>{selected.detail}</p>
                    {selected.badges?.length ? (
                        <ul>
                            {selected.badges.map(({ phase, label, gate }) => (
                                <li key={phase}>
                                    {phase} {label}
                                    {gate && (
                                        <>
                                            {' '}
                                            · <code>{gate}</code>
                                        </>
                                    )}
                                </li>
                            ))}
                        </ul>
                    ) : null}
                    {selected.href && <a href={selected.href}>関連ドキュメント</a>}
                </>
            ) : (
                <p>
                    ノードをクリックするか、Tab で選び Enter を押すと詳細を表示します。
                    {sequence ? '' : 'ドラッグで図を移動できます。'}
                </p>
            )}
        </div>
    )
}

export default function DiagramCanvas({ diagram }: { diagram: LaidOutDiagram }) {
    const diagramId = useId()
    const viewport = useRef<HTMLDivElement>(null)
    const api = useRef<ReactFlowInstance<FlowNode, FlowEdge> | null>(null)
    const sequence = diagram.presentation === 'sequence'
    const architecture = diagram.presentation === 'architecture'
    const firstStep = sequence ? diagram.nodes.find((node) => node.stepCode) : undefined
    const [selected, setSelected] = useState<PlacedNode | undefined>(firstStep)
    const roots = diagram.nodes.filter((node) => !node.parent)
    const diagramWidth = Math.max(...roots.map(({ x, width }) => x + width)) - Math.min(...roots.map(({ x }) => x))
    const diagramHeight = Math.max(...roots.map(({ y, height }) => y + height)) - Math.min(...roots.map(({ y }) => y))
    const proportional = !sequence && !architecture
    const frameStyle = sequence
        ? { height: Math.ceil(diagramHeight) + 40 }
        : proportional
          ? { aspectRatio: `${diagramWidth + 40} / ${diagramHeight + 40}` }
          : undefined
    const nodes = useMemo<FlowNode[]>(
        () =>
            diagram.nodes.map((item) => ({
                id: item.id,
                parentId: item.parent,
                position: { x: item.x, y: item.y },
                width: item.width,
                height: item.height,
                type: item.kind === 'group' ? 'group' : 'card',
                data: { item },
                selected: item.id === firstStep?.id,
                ariaLabel: [
                    item.label,
                    item.stepCode,
                    ...(item.badges?.map(({ phase, label, gate }) => [phase, label, gate].filter(Boolean).join(' ')) ??
                        []),
                ]
                    .filter(Boolean)
                    .join('、'),
            })),
        [diagram, firstStep]
    )
    const edges = useMemo<FlowEdge[]>(
        () =>
            diagram.edges.map((route) => ({
                id: route.id,
                source: route.from,
                target: route.to,
                type: 'orthogonal',
                data: { route },
                markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--diagram-line)' },
                zIndex: 1,
            })),
        [diagram]
    )
    const pan = (event: KeyboardEvent<HTMLDivElement>) => {
        const instance = api.current
        if (!instance || event.target !== event.currentTarget) {
            return
        }
        const delta = {
            ArrowLeft: [48, 0],
            ArrowRight: [-48, 0],
            ArrowUp: [0, 48],
            ArrowDown: [0, -48],
        }[event.key]
        if (!delta) {
            return
        }
        event.preventDefault()
        const { x, y, zoom } = instance.getViewport()
        void instance.setViewport({ x: x + delta[0]!, y: y + delta[1]!, zoom })
    }

    return (
        <div className="diagram-interactive">
            {!sequence && (
                <div className="diagram-tools" role="group" aria-label="図の表示操作">
                    <button type="button" onClick={() => void api.current?.zoomIn()} aria-label="拡大">
                        ＋
                    </button>
                    <button type="button" onClick={() => void api.current?.zoomOut()} aria-label="縮小">
                        −
                    </button>
                    <button
                        type="button"
                        onClick={() => void api.current?.fitView(architecture ? { ...fit, padding: '18px' } : fit)}
                    >
                        全体表示
                    </button>
                    <button
                        type="button"
                        onClick={() => api.current && resetView(api.current, viewport.current, sequence)}
                    >
                        初期表示
                    </button>
                </div>
            )}
            {architecture && (
                <div className="diagram-tools architecture-shortcuts" role="group" aria-label="表示する領域">
                    <button
                        type="button"
                        onClick={() => showArchitectureRegion(api.current, viewport.current, 'github')}
                    >
                        GitHub
                    </button>
                    <button type="button" onClick={() => showArchitectureRegion(api.current, viewport.current, 'main')}>
                        メイン
                    </button>
                    <button
                        type="button"
                        onClick={() => showArchitectureRegion(api.current, viewport.current, 'worktree')}
                    >
                        worktree
                    </button>
                </div>
            )}
            <div
                className={`diagram-viewport diagram-viewport--${diagram.direction.toLowerCase()}`}
                ref={viewport}
                style={frameStyle}
                data-proportional={proportional ? '' : undefined}
                tabIndex={sequence ? undefined : 0}
                role="region"
                aria-label={sequence ? 'Issue の処理順' : '図の表示領域（矢印キーで移動）'}
                onKeyDown={sequence ? undefined : pan}
            >
                <ReactFlow<FlowNode, FlowEdge>
                    id={diagramId}
                    defaultNodes={nodes}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    edgeTypes={edgeTypes}
                    nodesDraggable={false}
                    nodesConnectable={false}
                    edgesReconnectable={false}
                    edgesFocusable={false}
                    nodesFocusable
                    elementsSelectable
                    elevateNodesOnSelect={false}
                    zoomOnScroll={false}
                    zoomOnDoubleClick={false}
                    panOnDrag={!sequence}
                    zoomOnPinch={!sequence}
                    autoPanOnNodeFocus={!sequence}
                    preventScrolling={false}
                    minZoom={0.12}
                    maxZoom={2.5}
                    deleteKeyCode={null}
                    onInit={(instance) => {
                        api.current = instance
                        resetView(instance, viewport.current, sequence)
                    }}
                    onNodeClick={(_, node) => setSelected(node.data.item)}
                    onSelectionChange={({ nodes }) => {
                        if (nodes.length === 1) {
                            setSelected(nodes[0]?.data.item)
                        }
                    }}
                />
            </div>
            <DiagramDetails selected={selected} sequence={sequence} />
        </div>
    )
}
