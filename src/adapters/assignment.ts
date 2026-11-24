import { quote, render } from '../core/template.js'
import type { Exec, Step, Workflow } from '../core/types.js'

export type Assignment = { body: unknown; command: string }
function fields(step: Step, workflow: Workflow, issue: number, base: string) {
    return Object.fromEntries(
        Object.entries(
            step.remote?.agent_assignment ?? {
                target_repo: '{owner}/{repo}',
                base_branch: '{base}',
            }
        ).map(([k, v]) => [k, render(v, { ...workflow.vars, issue, base })])
    )
}
export class RestAssignment {
    async prepare(_exec: Exec, workflow: Workflow, step: Step, issue: number, base: string): Promise<Assignment> {
        const assignment = fields(step, workflow, issue, base)
        if (assignment.base_branch !== base) {
            throw new Error('agent_assignment.base_branch は固定する base と一致する必要があります')
        }
        return {
            command: step.remote!.assign,
            body: {
                assignees: [step.remote?.login ?? 'copilot-swe-agent[bot]'],
                agent_assignment: assignment,
            },
        }
    }
}
export class GraphQLAssignment {
    async prepare(exec: Exec, workflow: Workflow, step: Step, issue: number, base: string): Promise<Assignment> {
        const assignment = fields(step, workflow, issue, base)
        if (assignment.base_branch !== base) {
            throw new Error('agent_assignment.base_branch は固定する base と一致する必要があります')
        }
        const target = assignment.target_repo ?? `${workflow.vars.owner}/${workflow.vars.repo}`
        const [targetOwner, targetName] = target.split('/')
        const query = `query { repository(owner:${JSON.stringify(String(workflow.vars.owner))},name:${JSON.stringify(String(workflow.vars.repo))}) { issue(number:${issue}) { id } suggestedActors(capabilities:[CAN_BE_ASSIGNED],first:100) { nodes { login ... on Bot { id } ... on User { id } } } } target:repository(owner:${JSON.stringify(targetOwner)},name:${JSON.stringify(targetName)}) { id } }`
        const result = JSON.parse(
            await exec.run({
                command: `gh api graphql -f query=${quote(query)}`,
                cwd: String(workflow.vars.main),
                mutation: false,
            })
        )
        const data = result.data
        const login = (step.remote?.login ?? 'copilot-swe-agent[bot]').replace(/\[bot\]$/, '')
        const bot = data?.repository?.suggestedActors?.nodes?.find(
            (n: { login: string }) => n.login.replace(/\[bot\]$/, '') === login
        )
        if (!data?.repository?.issue?.id || !data?.target?.id || !bot?.id) {
            throw new Error('GraphQL アサインに必要な Issue / repository / Copilot ID がありません')
        }
        const names: Record<string, string> = {
            target_repo: 'targetRepositoryId',
            base_branch: 'baseRef',
            custom_instructions: 'customInstructions',
            custom_agent: 'customAgent',
            model: 'model',
        }
        const agentAssignment = Object.fromEntries(
            Object.entries(assignment).map(([key, value]) => [
                names[key] ?? key,
                key === 'target_repo' ? data.target.id : value,
            ])
        )
        return {
            command: step.remote!.assign,
            body: {
                query: 'mutation($input:ReplaceActorsForAssignableInput!) { replaceActorsForAssignable(input:$input) { assignable { ... on Issue { id } } } }',
                variables: {
                    input: { assignableId: data.repository.issue.id, actorIds: [bot.id], agentAssignment },
                },
            },
        }
    }
}
