import type { Workflow } from '../../../../src/core/types.ts'
import { architecture } from './architecture.ts'
import { concurrency } from './concurrency.ts'
import { lifecycle } from './lifecycle.ts'
import { stateMachine } from './state-machine.ts'
import { workflowDiagram } from './workflow.ts'

export function diagrams(workflow: Workflow) {
    const { progress, recovery } = stateMachine(workflow)
    return {
        architecture,
        workflow: workflowDiagram(workflow, true),
        workflowDetail: workflowDiagram(workflow),
        state: progress,
        stateRecovery: recovery,
        concurrency: concurrency(workflow),
        lifecycle,
    }
}
