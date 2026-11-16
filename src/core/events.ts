import { promises as fs } from "node:fs";
import path from "node:path";

import type { CommandFailure } from "./command-error.js";
import { FlowPaths, checkDate, localDate } from "./paths.js";

export type Event = {
  at: string;
  issue: number;
  step: string | null;
  event: string;
  message: string;
  dryRun?: boolean;
  commandFailure?: CommandFailure;
};
export type LogSelection = { date?: string; days?: number };
export function logDates(selection: LogSelection = {}, now = new Date()): string[] {
  if (selection.date && selection.days !== undefined) throw new Error("--date と --days は同時に指定できません");
  if (selection.date) return [checkDate(selection.date)];
  const days = selection.days ?? 1;
  if (!Number.isSafeInteger(days) || days <= 0) throw new Error("days は正の整数です");
  const today = new Date(`${localDate(now)}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) =>
    new Date(today.getTime() - (days - i - 1) * 86400000).toISOString().slice(0, 10),
  );
}
export class Events {
  readonly paths: FlowPaths;
  constructor(
    root: string,
    readonly dryRun = false,
    readonly now = () => new Date(),
  ) {
    this.paths = new FlowPaths(root);
  }
  async add(
    issue: number,
    step: string | null,
    event: string,
    message: string,
    commandFailure?: CommandFailure,
  ): Promise<void> {
    const at = this.now();
    const file = this.paths.event(localDate(at), this.dryRun);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(
      file,
      JSON.stringify({
        at: at.toISOString(),
        issue,
        step,
        event,
        message,
        dryRun: this.dryRun,
        commandFailure,
      } satisfies Event) + "\n",
      { mode: 0o600 },
    );
  }
  async read(issue?: number, selection: LogSelection = {}): Promise<Event[]> {
    const events: Event[] = [];
    for (const date of logDates(selection, this.now()))
      for (const dry of [false, true]) {
        const source = await fs.readFile(this.paths.event(date, dry), "utf8").catch((e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT") return "";
          throw e;
        });
        events.push(
          ...source
            .split("\n")
            .filter(Boolean)
            .map((x) => JSON.parse(x) as Event),
        );
      }
    return events
      .filter((e) => issue === undefined || e.issue === issue)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }
}
