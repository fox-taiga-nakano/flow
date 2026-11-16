import { normalizeAuthor } from "../core/identity.js";
import { quote } from "../core/template.js";
import type { Exec, RemoteAgent, Step, Tracker, Workflow } from "../types.js";
import { GraphQLAssignment, RestAssignment } from "./assignment.js";

export type TimelineEvent = {
  event: string;
  created_at?: string;
  actor?: { login: string };
  review_requester?: { login: string };
};
export { normalizeAuthor } from "../core/identity.js";

export function remoteStatus(
  events: TimelineEvent[],
  mode: string,
  authors: string[],
  isDraft: boolean,
): "working" | "done" | "failed" {
  if (mode === "not_draft") return isDraft ? "working" : "done";
  if (mode === "review_requested") {
    const review = [...events]
      .reverse()
      .find(
        (e) =>
          e.event === "review_requested" &&
          authors.map(normalizeAuthor).includes(normalizeAuthor(e.actor?.login ?? e.review_requester?.login ?? "")),
      );
    const failure = [...events].reverse().find((e) => e.event === "copilot_work_failed");
    if (failure && (!review || (failure.created_at ?? "") > (review.created_at ?? ""))) return "failed";
    return review ? "done" : "working";
  }
  const latest = [...events]
    .reverse()
    .find((e) => ["copilot_work_started", "copilot_work_finished", "copilot_work_failed"].includes(e.event));
  return latest?.event === "copilot_work_finished"
    ? "done"
    : latest?.event === "copilot_work_failed"
      ? "failed"
      : "working";
}
export class CopilotRemote implements RemoteAgent {
  constructor(
    readonly exec: Exec,
    readonly tracker: Tracker,
    readonly step: Step,
    readonly workflow: Workflow,
  ) {}
  async prepare(issue: number, base: string) {
    const transport = this.step.remote?.transport === "graphql" ? new GraphQLAssignment() : new RestAssignment();
    return transport.prepare(this.exec, this.workflow, this.step, issue, base);
  }
  async request(spec: { command: string }): Promise<void> {
    await this.exec.run({
      command: spec.command,
      cwd: String(this.workflow.vars.main),
      mutation: true,
    });
  }
  async poll(issue: number, since?: string): Promise<"pending" | "working" | "done" | "failed"> {
    const authors = this.step.remote?.authors ?? this.workflow.remote?.authors ?? ["Copilot", "copilot-swe-agent"];
    const prs = (await this.tracker.findPullRequests(issue)).filter(
      (p) => p.state === "open" && authors.map(normalizeAuthor).includes(normalizeAuthor(p.author)),
    );
    if (!prs.length) return "pending";
    if (prs.length > 1) throw new Error(`Copilot の open PR が複数あります: #${issue}`);
    const pr = prs[0]!;
    const mode = this.step.remote?.done_when ?? this.workflow.remote?.done_when ?? "timeline";
    const output =
      mode === "not_draft"
        ? "[]"
        : await this.exec.run({
            command: `gh api --method GET ${quote(`repos/{owner}/{repo}/issues/${pr.number}/timeline`)} --paginate --slurp`,
            cwd: String(this.workflow.vars.main),
            mutation: false,
          });
    return remoteStatus(
      (JSON.parse(output) as TimelineEvent[][])
        .flat()
        .filter((e) => !since || (!!e.created_at && Date.parse(e.created_at) >= Date.parse(since))),
      mode,
      authors,
      pr.isDraft,
    );
  }
}
