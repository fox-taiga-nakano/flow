import { Handle, type Node, type NodeProps, Position } from '@xyflow/react'

import type { Icon, PlacedNode } from '../../../diagrams/model'

export type FlowNode = Node<{ item: PlacedNode }, 'card' | 'group'>

const glyphs: Partial<Record<Icon, string>> = {
    person: 'M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM5 20v-2a7 7 0 0 1 14 0v2',
    terminal: 'M3 5h18v14H3zM6 9l3 3-3 3m6 0h5',
    file: 'M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6',
    folder: 'M3 6h7l2 2h9v11H3z',
    disk: 'M4 6c0-2 16-2 16 0v12c0 2-16 2-16 0zM4 6c0 2 16 2 16 0M4 12c0 2 16 2 16 0',
    server: 'M3 5h18v11H3zM8 20h8m-4-4v4',
    lock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3',
}

function NodeIcon({ icon }: { icon?: Icon }) {
    if (icon === 'github' || icon === 'copilot') {
        return (
            <span className={`diagram-brand diagram-brand--${icon}`} aria-hidden="true">
                <img
                    className="diagram-brand-light"
                    src={`/diagram-icons/${icon}-light.svg`}
                    alt=""
                    width={24}
                    height={24}
                />
                <img
                    className="diagram-brand-dark"
                    src={`/diagram-icons/${icon}-dark.svg`}
                    alt=""
                    width={24}
                    height={24}
                />
            </span>
        )
    }
    if (icon === 'claude' || icon === 'codex') {
        return (
            <img
                className={`diagram-icon diagram-icon--${icon}`}
                src={`/diagram-icons/${icon === 'codex' ? 'codex-terminal' : 'claude'}.svg`}
                alt=""
                width={24}
                height={24}
            />
        )
    }
    return (
        <svg className="diagram-icon" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <path
                d={icon ? glyphs[icon] : 'M12 3l9 9-9 9-9-9z'}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinejoin="round"
            />
        </svg>
    )
}

export function DiagramCard({ data, selected }: NodeProps<FlowNode>) {
    const { item } = data
    if (item.stepCode) {
        const approval = item.badges
            ?.filter(({ tone }) => tone === 'manual')
            .map(({ phase }) => phase)
            .join('・')
        return (
            <div className="diagram-card diagram-step" data-selected={selected}>
                <Handle type="target" position={Position.Top} isConnectable={false} />
                <strong>{item.label}</strong>
                {approval && <small>要承認 {approval}</small>}
                <Handle type="source" position={Position.Bottom} isConnectable={false} />
            </div>
        )
    }
    if (item.subtitle) {
        return (
            <div
                className={`diagram-card architecture-card architecture-card--${item.icon ?? 'tool'} diagram-tone--${item.tone ?? 'neutral'}`}
                data-selected={selected}
            >
                <Handle type="target" position={Position.Left} isConnectable={false} />
                {item.icon && item.icon !== 'copilot' && (
                    <span className="architecture-icon">
                        <NodeIcon icon={item.icon} />
                    </span>
                )}
                <span className="architecture-node-copy">
                    {item.icon === 'copilot' ? <NodeIcon icon={item.icon} /> : <strong>{item.label}</strong>}
                    <small>{item.subtitle}</small>
                </span>
                <Handle type="source" position={Position.Right} isConnectable={false} />
            </div>
        )
    }
    return (
        <div
            className={`diagram-card diagram-card--${item.kind} diagram-tone--${item.tone ?? 'neutral'}`}
            data-selected={selected}
        >
            <Handle type="target" position={Position.Left} isConnectable={false} />
            <NodeIcon icon={item.icon} />
            <span className={item.icon === 'copilot' ? 'diagram-copilot-label' : undefined}>{item.label}</span>
            <Handle type="source" position={Position.Right} isConnectable={false} />
        </div>
    )
}

export function DiagramGroup({ data, selected }: NodeProps<FlowNode>) {
    return (
        <div className={`diagram-group${data.item.parent ? ' diagram-group--inner' : ''}`} data-selected={selected}>
            {data.item.label}
            {data.item.subtitle && <small>{data.item.subtitle}</small>}
        </div>
    )
}
