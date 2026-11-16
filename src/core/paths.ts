import path from "node:path";

export function localDate(at = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}
export function checkDate(date: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
  )
    throw new Error("date は YYYY-MM-DD の実在する日付です");
  return date;
}
export class FlowPaths {
  constructor(readonly root: string) {}
  static forProject(main: string) {
    return new FlowPaths(path.join(main, ".flow"));
  }
  get state() {
    return path.join(this.root, "state");
  }
  get run() {
    return path.join(this.root, "run");
  }
  get logs() {
    return path.join(this.root, "logs");
  }
  get workflow() {
    return path.join(this.root, "WORKFLOW.md");
  }
  get owned() {
    return path.join(this.state, "owned.json");
  }
  get issues() {
    return path.join(this.state, "issues.json");
  }
  get workflowGood() {
    return path.join(this.state, "workflow-good.json");
  }
  get locksDirectory() {
    return path.join(this.state, "locks");
  }
  get lockRegistry() {
    return path.join(this.locksDirectory, "registry.json");
  }
  get flowPid() {
    return path.join(this.run, "flow.pid");
  }
  /** Where `flow watch` stopped reading the production logs. */
  get watchCursor() {
    return path.join(this.run, "watch.json");
  }
  /** Asks a running `flow run` to tick now; it removes the file when it does. */
  get wake() {
    return path.join(this.run, "wake");
  }
  get tickPid() {
    return path.join(this.run, "tick.pid");
  }
  get ownedPid() {
    return path.join(this.run, "owned.pid");
  }
  get locksPid() {
    return path.join(this.run, "locks.pid");
  }
  get migrationPid() {
    return path.join(this.run, "migration.pid");
  }
  get plan() {
    return path.join(this.run, "last-plan.json");
  }
  /** Outside the Issue directory, which moves with the stage while the agent runs. */
  guard(agent: string) {
    return path.join(this.run, "guard", `${agent}.md`);
  }
  get assignmentTemp() {
    return path.join(this.run, "assign-");
  }
  assignment(issue: number) {
    return path.join(this.state, "previews", `assignment-${issue}.json`);
  }
  event(date: string, dryRun = false) {
    return path.join(this.logs, checkDate(date), dryRun ? "events.dry-run.ndjson" : "events.ndjson");
  }
  virtualIssue(issue: number) {
    return path.join(this.run, "dry-run", "issues", String(issue));
  }
  virtualWorkspace(key: string) {
    return path.join(this.run, "dry-run", "workspaces", key);
  }
  legacy(name: string) {
    return path.join(this.run, name);
  }
  static issueFlow(dir: string) {
    return path.join(dir, "flow");
  }
  static issueState(dir: string) {
    return path.join(this.issueFlow(dir), "state.json");
  }
  static result(dir: string, step: string | null, attempt: number, suffix = "") {
    return path.join(this.issueFlow(dir), `result-${step}-${attempt}${suffix}.json`);
  }
  static assignmentBody(dir: string) {
    return path.join(dir, "body.json");
  }
  static ports(dir: string) {
    return path.join(dir, ".ports.env");
  }
  static comment(dir: string) {
    return path.join(dir, "ng-comment.md");
  }
}
