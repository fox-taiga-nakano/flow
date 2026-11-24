import { CommandError } from '../core/command-error.js'
import { quote } from '../core/template.js'
import type { Exec, Tracker, TrackerIssue, TrackerPR, Workflow } from '../core/types.js'

export type RawIssue = {
    number: number
    title: string
    state: string
    assignees: { login: string }[]
    labels: { name: string }[]
    createdAt: string
    url: string
}
export type RawPR = {
    number: number
    headRefName: string
    baseRefName: string
    state: string
    isDraft: boolean
    author: { login: string } | null
    url: string
    closingIssuesReferences?: { number: number; url?: string }[]
    body?: string
}
export const parseIssue = (x: RawIssue): TrackerIssue => ({
    ...x,
    state: x.state.toLowerCase() as TrackerIssue['state'],
    assignees: x.assignees.map((a) => a.login),
    labels: x.labels.map((l) => l.name),
})
export const parsePR = (x: RawPR): TrackerPR => ({
    number: x.number,
    branch: x.headRefName,
    base: x.baseRefName,
    state: x.state.toLowerCase() as TrackerPR['state'],
    isDraft: x.isDraft,
    author: x.author?.login ?? '',
    url: x.url,
})
export class GitHubTracker implements Tracker {
    private issuesSnapshot = new Map<number, Promise<TrackerIssue | null>>()
    private prsSnapshot?: Promise<Map<number, TrackerPR[]>>
    private tickIssues?: Set<number>
    constructor(
        readonly exec: Exec,
        readonly config: Workflow['tracker'],
        readonly main: string
    ) {}
    async read(command: string): Promise<string> {
        return this.exec.run({ command, cwd: this.main, mutation: false })
    }
    private async readIssueBatch(command: string): Promise<string> {
        try {
            return await this.read(command)
        } catch (error) {
            // gh exits nonzero for partial GraphQL errors, including missing Issues.
            // Keep healthy aliases without hiding transport or authentication failures.
            if (error instanceof CommandError) {
                const stdout = (error.cause as { stdout?: string } | undefined)?.stdout
                if (stdout) {
                    try {
                        const partial = JSON.parse(stdout)
                        if (partial?.data?.repository && Array.isArray(partial.errors)) {
                            return stdout
                        }
                    } catch {
                        // Preserve the original command failure when stdout is not GraphQL data.
                    }
                }
            }
            throw error
        }
    }
    async listCandidates(): Promise<TrackerIssue[]> {
        const args = Object.entries(this.config.query)
            .map(([key, value]) => {
                if (!['assignee', 'state', 'label', 'search', 'milestone', 'author'].includes(key)) {
                    throw new Error(`tracker.query: 未対応の条件 ${key}`)
                }
                return `--${key} ${quote(value)}`
            })
            .join(' ')
        const rows = JSON.parse(
            await this.read(
                `gh issue list ${args} --limit 10000 --json number,title,state,assignees,labels,createdAt,url`
            )
        ) as RawIssue[]
        const issues = rows.map(parseIssue)
        for (const issue of issues) {
            this.issuesSnapshot.set(issue.number, Promise.resolve(issue))
        }
        return issues.filter((i) => !i.labels.some((l) => this.config.exclude_labels.includes(l)))
    }
    async getIssue(n: number): Promise<TrackerIssue | null> {
        if (this.tickIssues) {
            if (!this.tickIssues.has(n)) {
                return null
            }
            const snapshot = this.issuesSnapshot.get(n)
            if (!snapshot) {
                throw new Error(`tick の Issue スナップショットがありません: #${n}`)
            }
            return snapshot
        }
        try {
            return parseIssue(
                JSON.parse(
                    await this.read(`gh issue view ${n} --json number,title,state,assignees,labels,createdAt,url`)
                )
            )
        } catch (e) {
            if (/could not resolve|not found|HTTP 404/i.test(String(e))) {
                return null
            }
            throw e
        }
    }
    beginTick(): void {
        this.issuesSnapshot.clear()
        this.prsSnapshot = undefined
        this.tickIssues = undefined
    }
    endTick(): void {
        this.beginTick()
    }
    async prepareTick(numbers: number[]): Promise<void> {
        this.tickIssues = new Set(numbers)
        const missing = [...this.tickIssues].filter((n) => !this.issuesSnapshot.has(n))
        const pending: Promise<unknown>[] = []
        // Repository aliases avoid search-index lag and work for both open and closed issues.
        for (let offset = 0; offset < missing.length; offset += 100) {
            const batch = missing.slice(offset, offset + 100)
            const fields = batch.map((n) => `i${n}: issue(number:${n}) { ...IssueFields }`).join(' ')
            const query = `query($owner:String!,$repo:String!) {
        repository(owner:$owner,name:$repo) { ${fields} }
      }
      fragment IssueFields on Issue {
        number title state createdAt url
        assignees(first:100) { nodes { login } pageInfo { hasNextPage } }
        labels(first:100) { nodes { name } pageInfo { hasNextPage } }
      }`
            const response = this.readIssueBatch(
                `gh api graphql -F owner='{owner}' -F repo='{repo}' -f query=${quote(query)}`
            ).then((text) => {
                const data = JSON.parse(text) as {
                    errors?: { message: string; type?: string; path?: (string | number)[] }[]
                    data?: { repository?: Record<string, GraphQLIssue | null> | null }
                }
                if (!data.data?.repository) {
                    throw new Error('GitHub の Issue 一括取得結果が不正です')
                }
                return data
            })
            for (const n of batch) {
                const issue = response.then((data) => {
                    const row = data.data!.repository![`i${n}`]
                    const errors = data.errors?.filter((e) => !e.path || e.path.includes(`i${n}`))
                    if (errors?.length && !(row === null && errors.every((e) => e.type === 'NOT_FOUND'))) {
                        throw new Error(errors.map((e) => e.message).join('; '))
                    }
                    if (row === undefined) {
                        throw new Error(`GitHub の Issue 一括取得結果に #${n} がありません`)
                    }
                    if (row === null) {
                        return null
                    }
                    if (row.assignees.pageInfo.hasNextPage || row.labels.pageInfo.hasNextPage) {
                        throw new Error(`GitHub Issue #${n}: assignees または labels が100件を超えています`)
                    }
                    return parseIssue({ ...row, assignees: row.assignees.nodes, labels: row.labels.nodes })
                })
                this.issuesSnapshot.set(n, issue)
                pending.push(issue)
            }
        }
        if (numbers.length) {
            pending.push(this.pullRequests())
        }
        // Keep failures in their snapshots. The existing per-Issue error handler records
        // them without treating a failed lookup as an empty/deleted Issue or retrying N times.
        await Promise.allSettled(pending)
    }
    private pullRequests(): Promise<Map<number, TrackerPR[]>> {
        return (this.prsSnapshot ??= (async () => {
            const rows = JSON.parse(
                await this.read(
                    `gh pr list --state all --limit ${this.config.pr_limit ?? 100} --json number,headRefName,baseRefName,state,isDraft,author,url,closingIssuesReferences`
                )
            ) as RawPR[]
            const byIssue = new Map<number, TrackerPR[]>()
            for (const row of rows) {
                if (!Array.isArray(row.closingIssuesReferences)) {
                    throw new Error('closingIssuesReferences が不正です')
                }
                const pr = parsePR(row)
                for (const ref of row.closingIssuesReferences) {
                    // A PR may close issues in another repository with the same issue number.
                    if (ref.url && ref.url.replace(/\/issues\/\d+$/, '') !== row.url.replace(/\/pull\/\d+$/, '')) {
                        continue
                    }
                    if (this.tickIssues && !this.tickIssues.has(ref.number)) {
                        continue
                    }
                    const prs = byIssue.get(ref.number) ?? []
                    if (!prs.some((p) => p.number === pr.number)) {
                        prs.push(pr)
                    }
                    byIssue.set(ref.number, prs)
                }
            }
            return byIssue
        })())
    }
    async findPullRequests(issue: number): Promise<TrackerPR[]> {
        if (this.tickIssues && !this.tickIssues.has(issue)) {
            return []
        }
        return (await this.pullRequests()).get(issue) ?? []
    }
}

type GraphQLIssue = Omit<RawIssue, 'assignees' | 'labels'> & {
    assignees: { nodes: { login: string }[]; pageInfo: { hasNextPage: boolean } }
    labels: { nodes: { name: string }[]; pageInfo: { hasNextPage: boolean } }
}
