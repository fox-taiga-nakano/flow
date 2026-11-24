import type { Ownership } from './ownership.js'

export type TrackerIssue = {
    number: number
    title: string
    state: 'open' | 'closed'
    assignees: string[]
    labels: string[]
    createdAt: string
    url: string
}
export type TrackerPR = {
    number: number
    branch: string
    base: string
    state: 'open' | 'merged' | 'closed'
    isDraft: boolean
    author: string
    url: string
}
export type WorkspaceInfo = {
    key: string
    path: string
    workspaceId: string | null
    branch: string
    slot: number | null
    base?: string
}
export type AgentHandle = {
    runner: string
    name: string
    paneId?: string
    tabId?: string
    sessionId?: string
    /** The agent lives in the worktree's shared agent tab, which outlives it. */
    keepTab?: boolean
}
/** Where an agent's tab goes: its own flow-<issue> tab in the main workspace, or the worktree's first tab. */
export type AgentPlace = 'main' | 'worktree'
export type RunnerAgent = {
    name?: string
    paneId: string
    workspaceId: string | null
    cwd?: string
    status: AgentStatus
    sessionId?: string
}
export type AgentStatus = 'working' | 'idle' | 'blocked' | 'done' | 'gone'
export interface Tracker {
    beginTick?(): void
    prepareTick?(issues: number[]): Promise<void>
    endTick?(): void
    listCandidates(): Promise<TrackerIssue[]>
    getIssue(n: number): Promise<TrackerIssue | null>
    findPullRequests(issue: number): Promise<TrackerPR[]>
}
export interface StageStore {
    beginTick?(): void
    /** Drops what is cached for the Issue, after something outside the store may have moved it. */
    forget?(issue: number): void
    get(issue: number): Promise<string | null>
    set(issue: number, stage: string): Promise<void>
    ensure(issue: number): Promise<string>
    dir(issue: number): Promise<string>
}
export interface Workspace {
    ensure(spec: {
        key: string
        branch: string
        base?: string
        owner: { issue: number; step: string }
    }): Promise<WorkspaceInfo>
    sync(ws: WorkspaceInfo): Promise<void>
    remove(ws: WorkspaceInfo): Promise<void>
    list(): Promise<WorkspaceInfo[]>
}
export interface Runner {
    list(): Promise<RunnerAgent[]>
    focusTab(tabId: string): Promise<void>
    start(spec: {
        name: string
        ws: WorkspaceInfo
        kind: 'claude' | 'codex'
        owner: { issue: number; step: string }
        place?: AgentPlace
        /** Appended to the agent's system prompt so it holds for the whole session. */
        systemPromptFile?: string
    }): Promise<AgentHandle>
    ready(h: AgentHandle): Promise<'ready' | 'blocked' | 'pending' | 'gone'>
    close(h: AgentHandle): Promise<void>
    closeIssueTab(issue: number): Promise<boolean>
    status(h: AgentHandle): Promise<AgentStatus>
    /** Resolves only after observed delivery; uncertain submission must reject. */
    prompt(h: AgentHandle, text: string): Promise<void>
    tail(h: AgentHandle, lines: number): Promise<string>
    stop(h: AgentHandle): Promise<void>
}
export interface RemoteAgent {
    prepare(issue: number, base: string): Promise<{ body: unknown; command: string }>
    request(spec: { command: string }): Promise<void>
    poll(issue: number, since?: string): Promise<'pending' | 'working' | 'done' | 'failed'>
}
export interface Notifier {
    notify(msg: {
        issue: number
        title: string
        body: string
        level: 'info' | 'action' | 'error'
        gate?: { name: string; summary: string; artifacts: string[]; command: string; issueDir?: string }
    }): Promise<void>
}
export type ExecRequest = { command: string; cwd?: string; mutation: boolean; timeoutMs?: number }
export interface Exec {
    run(request: ExecRequest): Promise<string>
}
export type DbResetRequest = { id: string; mode: 'snapshot' | 'seed'; reason: string }
export type AgentResult = {
    result: 'ok' | 'ng' | 'blocked' | 'failed'
    summary: string
    needs?: string
    artifacts: string[]
    db_reset?: DbResetRequest
}
export type Transition = {
    remove_workspaces?: string[]
    set_stage?: string
    stop?: boolean
    notify?: 'info' | 'action' | 'error'
    gate?: string
}
export type Step = {
    /** agent の result.json から flow 本体に DB リセットを依頼できる。 */
    db_reset?: boolean
    when_stage?: string
    when_pr_merged?: boolean
    gate_before?: string
    gate_after?: string
    /** gate_before で `--choice skip` を受け付け、step を実行せずに完了にする。 */
    skippable?: boolean
    workspace?: 'none' | { from_base?: string; branch?: string; pr?: boolean }
    agent?: { kind: 'claude' | 'codex'; name: string }
    locks?: string[]
    remote?: {
        kind: 'copilot'
        assign: string
        transport?: 'rest' | 'graphql'
        login?: string
        agent_assignment?: Record<string, string>
        authors?: string[]
        done_when?: RemoteDone
    }
    done_when?: { files?: string[]; stage_in?: string[] }
    on_ok?: Transition
    on_ng?: Transition
    on_done?: Transition
    on_approve?: { command?: string; prompt?: string }
    action?: { remove_workspaces?: boolean; command?: string }
}
export type RemoteDone = 'timeline' | 'review_requested' | 'not_draft'
export type Workflow = {
    database?: { stop: string; reset: { snapshot: string; seed: string } }
    version: 1
    timezone?: string
    tracker: {
        kind: 'github'
        query: Record<string, string>
        exclude_labels: string[]
        /** An Issue with one of these labels moves to stage_store.held once its current step ends. */
        hold_labels?: string[]
        pr_limit?: number
    }
    stage_store: {
        kind: 'dirs'
        initial: string
        rejected: string
        held?: string
        order?: string[]
        pattern?: string
        commands: { dir: string; ensure: string; set: string; get?: string }
    }
    workspace: {
        kind: 'herdr'
        commands: {
            list: string
            create_for_branch: string
            create_from_base: string
            sync: string
            remove: string
            assign_slot?: string
        }
    }
    runner: { kind: 'herdr'; close_on_complete?: boolean }
    notifier: { kind: 'command'; command?: string | null }
    concurrency: { global: number; per_step: Record<string, number> }
    locks: { slots: number[]; resources: Record<string, { kind: 'rw' }> }
    retry: { max_attempts: number; backoff_ms: number[] }
    stall_ms: number
    gates: Record<string, 'manual' | 'auto'>
    steps: Record<string, Step>
    base: { resolve: string }
    vars: Record<string, string | number>
    remote?: {
        authors: string[]
        done_when: RemoteDone
        ng_action?: { command: string; set_stage: string; choice?: 'copilot' | 'self' | 'stop' }
    }
    prompts: Record<string, string>
}
export type Gate = {
    name: string
    since: string
    summary: string
    artifacts: string[]
    phase: 'before' | 'after' | 'ng' | 'question' | 'db' | 'recovery' | 'adopt' | 'base'
    workspace?: WorkspaceInfo
    resume?: Status
    decision?: string
}
export type Status =
    | 'idle'
    | 'running'
    | 'waiting_gate'
    | 'waiting_remote'
    | 'retry_wait'
    | 'failed'
    | 'stopped'
    | 'done'
export type State = {
    version: 1
    issue: number
    step: string | null
    status: Status
    attempt: number
    agent: AgentHandle | null
    /** Worker from legacy state, retained for cleanup compatibility. */
    worker?: AgentHandle | null
    workspace: WorkspaceInfo | null
    workspaces: WorkspaceInfo[]
    locks: string[]
    gate: Gate | null
    nextRetryAt: string | null
    startedAt: string | null
    updatedAt: string
    statusChangedAt?: string
    initialPrompt?: string
    /** Issue tab is occupied; suppress duplicate notifications until it becomes available. */
    issueTabBusy?: boolean
    lastActivityAt: string
    history: { step: string | null; attempt: number; result: string; reason: string; at: string }[]
    approvals: string[]
    completed: string[]
    resultReminder?: boolean
    tailHash?: string
    continuation?: boolean
    retainResources?: boolean
    /** cleanup を `--choice keep` で承認した。worktree は消さず、記録とロックだけ外す。 */
    keepWorkspaces?: boolean
    remoteRetry?: boolean
    approvedGate?: Gate
    remoteSince?: string
    pendingResult?: AgentResult
    dbReset?: DbResetRequest & { key: string; workspace: WorkspaceInfo }
    inflight?: { key: string; command: string }
    effects: string[]
    launchPending?: boolean
    base?: string
    baseAccepted?: string
    rejectedFromStage?: string
    /** The stage before a hold label moved the Issue to stage_store.held. */
    heldFromStage?: string
    baseChange?: {
        signature: string
        current: string
        pr?: number
        resume: Status
        gate: Gate | null
        retarget?: boolean
    }
}
export type Adapters = {
    ownership?: Ownership
    tracker: Tracker
    stages: StageStore
    workspace: Workspace
    runner: Runner
    notifier: Notifier
    remote(step: Step): RemoteAgent
    exec: Exec
}
