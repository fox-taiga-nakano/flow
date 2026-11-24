import { BaseEdge, type Edge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react'

import type { RoutedEdge } from '../../../diagrams/model'

export type FlowEdge = Edge<{ route: RoutedEdge }, 'orthogonal'>

export function OrthogonalEdge({ id, data, markerEnd }: EdgeProps<FlowEdge>) {
    if (!data) {
        return null
    }
    const { route } = data
    return (
        <>
            {route.points.map((line, index) => {
                const path = line.map(({ x, y }, i) => `${i === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ')
                return (
                    <BaseEdge
                        key={path}
                        id={index === 0 ? id : `${id}-${index}`}
                        path={path}
                        markerEnd={index === route.points.length - 1 ? markerEnd : undefined}
                        style={{ stroke: 'var(--diagram-line)', strokeWidth: 1.6 }}
                        interactionWidth={0}
                    />
                )
            })}
            {route.caption && (
                <EdgeLabelRenderer>
                    <span
                        className="diagram-edge-label"
                        style={{
                            transform: `translate(-50%, -50%) translate(${route.caption.x}px, ${route.caption.y}px)`,
                        }}
                    >
                        {route.label}
                    </span>
                </EdgeLabelRenderer>
            )}
        </>
    )
}
