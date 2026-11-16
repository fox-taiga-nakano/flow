import Table from "cli-table3";
import { inspect, stripVTControlCharacters } from "node:util";
import pc from "picocolors";
import stringWidth from "string-width";

import type { Event } from "./core/events.js";
import type { HeldLock, Waiter } from "./core/locks.js";
import type { StatusRow } from "./core/orchestrator.js";
import { type IssueLocation, elapsedTime, pathTail, relativeArtifacts, wrapText } from "./display-text.js";
import type { Notifier, State } from "./types.js";

export type Tone = "pending" | "active" | "error" | "success" | "inactive" | "muted";
export type Cell =
  | { text: string; tone?: Tone; path?: boolean; prose?: boolean; href?: string; changed?: boolean }
  | string;
/** Fields of a status row that `flow run` marks when a tick changes them. */
export type ChangedField = "stage" | "step" | "status" | "gate";
/** The web page of an Issue, when the workflow names its repository. */
export type IssueLink = (issue: number) => string | undefined;
type DisplayStream = { isTTY?: boolean; columns?: number };
export type DisplayOptions = { isTTY?: boolean; columns?: number; env?: NodeJS.ProcessEnv; stream?: DisplayStream };
const plain = (value: unknown): string =>
  stripVTControlCharacters(
    typeof value === "string"
      ? value
      : typeof value === "number" ||
          typeof value === "boolean" ||
          typeof value === "bigint" ||
          typeof value === "symbol"
        ? String(value)
        : value == null
          ? "-"
          : value instanceof Error
            ? value.toString()
            : inspect(value, { depth: 2, breakLength: Infinity }),
  )
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ");
const valueOf = (cell: Cell) => (typeof cell === "string" ? cell : cell.text);

/** 状態・step・gate・agent を「いま何を待っているか」の一言にまとめる。細かい値は status <番号> と --json に残る。 */
export function nowLabel(
  r: {
    stage: string | null;
    step: string | null;
    status: string;
    gate: string | null;
    agent: string | null;
    slot: number | null;
  },
  rejected = "対象外",
): string {
  const step = r.step ?? "-";
  switch (r.status) {
    case "waiting_gate":
      // gate 名は gate の列に出す
      return r.gate === "agent_question" ? `ペインで質問に回答（${step}）` : "承認待ち";
    case "failed":
      return `失敗（${step}）。flow logs で原因を確認`;
    case "running":
      // agent・slot は各列に出す
      return `作業中: ${step}`;
    case "waiting_remote":
      return `Copilot の作業待ち（${step}）`;
    case "retry_wait":
      return `再試行待ち（${step}）`;
    case "done":
      if (r.step === "cleanup" || r.stage === "完了") return "終了";
      return r.step === "finish" ? "マージ待ち" : `${step} 完了。次の段階待ち`;
    case "stopped":
      if (r.stage === rejected) return "対象外";
      if (r.stage === "保留") return "保留中";
      // 段階は完了だが flow は処理せずに止めた（別の人が対応した など）
      return r.stage === "完了" ? "flow 外で完了" : "停止中";
    default:
      return r.step ? `次の tick で ${step}` : "次の tick を待つ";
  }
}
export function stateTone(status: string, excluded = false): Tone | undefined {
  if (excluded || status === "stopped") return "inactive";
  if (["failed", "error"].includes(status)) return "error";
  if (["waiting_gate", "retry_wait", "blocked"].includes(status)) return "pending";
  if (["running", "working", "waiting_remote"].includes(status)) return "active";
  if (["done", "ok", "success"].includes(status)) return "success";
  return undefined;
}
function eventTone(event: string): Tone {
  if (/error|fail|stall/i.test(event)) return "error";
  if (/stop|reject/i.test(event)) return "inactive";
  if (/gate|action|question|warning|retry/i.test(event)) return "pending";
  if (/done|success|complete|approved/i.test(event)) return "success";
  if (/start|running|working/i.test(event)) return "active";
  return "muted";
}

export class Output {
  readonly colors;
  readonly stream: DisplayStream;
  constructor(readonly options: DisplayOptions = {}) {
    const env = options.env ?? process.env;
    this.stream = options.stream ?? process.stdout;
    this.colors = pc.createColors(
      !!(options.isTTY ?? this.stream.isTTY) &&
        !("NO_COLOR" in env) &&
        env.TERM !== "dumb" &&
        !process.argv.includes("--no-color"),
    );
  }
  /** Terminal hyperlinks (OSC 8) only where a person reads the output. */
  get links(): boolean {
    const env = this.options.env ?? process.env;
    return !!(this.options.isTTY ?? this.stream.isTTY) && env.TERM !== "dumb";
  }
  get columns(): number {
    const tty = this.options.isTTY ?? this.stream.isTTY;
    const measured = this.options.columns ?? (tty ? this.stream.columns : undefined);
    return typeof measured === "number" && Number.isFinite(measured) && measured >= 1
      ? Math.floor(measured)
      : tty
        ? 80
        : 120;
  }
  prose(text: unknown, tone?: Tone, indent = "", columns = this.columns): string {
    return this.tone(wrapText(plain(text), columns, indent), tone);
  }
  tone(text: unknown, tone?: Tone): string {
    const content = plain(text);
    const color = {
      pending: this.colors.yellow,
      active: this.colors.blue,
      error: this.colors.red,
      success: this.colors.green,
      inactive: this.colors.gray,
      muted: this.colors.dim,
    };
    return tone ? color[tone](content) : content;
  }
  heading(text: string): string {
    return this.colors.bold(plain(text));
  }
  result(text: string, tone: Tone = "success"): string {
    const symbol = tone === "error" ? "✖" : tone === "pending" ? "!" : "✔";
    return this.tone(`${symbol} ${plain(text).replace(/\s*\n\s*/g, " ")}`, tone);
  }
  time(value?: string | null, timezone = "Asia/Tokyo"): string {
    if (!value) return "-";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return plain(value);
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(date)
        .map((p) => [p.type, p.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }
  table(headers: string[], source: Cell[][]): string {
    const rows: Cell[][] = source.length
      ? source
      : [headers.map((_, i) => ({ text: i === 0 ? "(なし)" : "-", tone: "muted" as const }))];
    const minimum = headers.map((h) => Math.max(6, stringWidth(h) + 2));
    if (minimum.reduce((a, b) => a + b, headers.length + 1) > this.columns && headers.length > 2) {
      // At small widths preserve every field in a two-column card per record.
      return source.length
        ? source
            .map((row) =>
              this.table(
                ["項目", "値"],
                headers.map((h, i) => [h, row[i] ?? "-"]),
              ),
            )
            .join("\n")
        : this.table(["項目", "値"], [["一覧", "(なし)"]]);
    }
    const widths = headers.map((header, i) =>
      Math.max(
        minimum[i]!,
        ...[header, ...rows.map((r) => plain(valueOf(r[i] ?? "-")))].flatMap((text) =>
          text.split("\n").map((line) => stringWidth(line) + 2),
        ),
      ),
    );
    // Allocate column widths only; cli-table3 owns padding, wrapping, truncation and borders.
    const floor = headers.length === 2 ? headers.map(() => 3) : minimum;
    while (widths.reduce((a, b) => a + b, headers.length + 1) > this.columns) {
      const reducible = widths.map((w, i) => (w > floor[i]! ? w : -1));
      const at = reducible.indexOf(Math.max(...reducible));
      if (reducible[at] === -1) break;
      widths[at]!--;
    }
    const table = new Table({
      head: headers.map((h) => this.heading(h)),
      colWidths: widths,
      wordWrap: true,
      wrapOnWordBoundary: true,
      style: { head: [], border: [], compact: true, "padding-left": 1, "padding-right": 1 },
    });
    table.push(
      ...rows.map((row) =>
        row.map((cell, index) => {
          if (typeof cell === "string") return plain(cell);
          const text = cell.path
            ? plain(cell.text)
                .split("\n")
                .map((line) => pathTail(line, Math.max(1, widths[index]! - 2)))
                .join("\n")
            : cell.text;
          const href = cell.href && this.links ? { href: cell.href } : {};
          if (cell.prose)
            return {
              content: this.prose(text, cell.tone, "", Math.max(2, widths[index]! - 2)),
              wordWrap: false,
              ...href,
            };
          const content = cell.changed
            ? this.colors.bold(this.colors.underline(this.tone(text, cell.tone)))
            : this.tone(text, cell.tone);
          return cell.href && this.links ? { content, ...href } : content;
        }),
      ),
    );
    return table.toString();
  }
  /** Every gate still waiting, so a redrawn frame keeps what the one-time notice said. */
  answers(rows: StatusRow[], link?: IssueLink): string {
    const waiting = rows.filter((r) => r.answer);
    if (!waiting.length) return this.prose("承認待ちはありません", "muted");
    return `${this.prose(`承認待ち（${waiting.length} 件）`, "pending")}\n${this.table(
      ["Issue", "gate", "すること"],
      waiting.map((r) => [
        { text: `#${r.issue}`, href: link?.(r.issue) },
        { text: r.gate ?? "-", tone: "pending" },
        r.answer!,
      ]),
    )}`;
  }
  status(
    rows: StatusRow[],
    rejected = "対象外",
    link?: IssueLink,
    changed?: ReadonlyMap<number, ReadonlySet<ChangedField>>,
  ): string {
    return this.table(
      ["Issue", "段階", "いま", "gate", "agent", "slot", "経過", "補足"],
      rows.map((r) => {
        const tone = stateTone(r.status, r.stage === rejected);
        const marked = (field: ChangedField) => changed?.get(r.issue)?.has(field) ?? false;
        return [
          { text: `#${r.issue}`, tone, href: link?.(r.issue) },
          { text: r.stage ?? "-", tone: r.stage === rejected ? "inactive" : undefined, changed: marked("stage") },
          {
            text: nowLabel(r, rejected),
            tone,
            changed: marked("step") || marked("status"),
          },
          { text: r.gate ?? "-", tone: r.gate ? "pending" : "muted", changed: marked("gate") },
          r.agent ?? "-",
          String(r.slot ?? "-"),
          elapsedTime(r.elapsed),
          {
            text: [r.planned ? "[予定]" : "", r.error ?? ""].filter(Boolean).join("\n") || "-",
            tone: r.error ? "error" : "muted",
            prose: !!r.error,
          },
        ];
      }),
    );
  }
  details(state: State | null | undefined, timezone?: string, excluded = false, location?: IssueLocation): string {
    const rows: Cell[][] = [];
    const visit = (value: unknown, key: string) => {
      if (value && typeof value === "object" && Object.keys(value).length) {
        for (const [name, item] of Object.entries(value)) visit(item, key ? `${key}.${name}` : name);
      } else {
        const label = key.split(".").at(-1)!;
        let text = Array.isArray(value) ? "[]" : plain(value);
        if (typeof value === "string" && /(?:At|Since|since|at)$/.test(label)) text = this.time(value, timezone);
        if (key.includes("artifacts.")) text = relativeArtifacts(text, location);
        rows.push([
          key || "状態",
          {
            text,
            tone: label === "status" ? stateTone(text, excluded) : undefined,
            path: key.includes("artifacts.") || /(?:path|workspacePath)$/i.test(label),
            prose: !key.includes("artifacts.") && !/(?:path|workspacePath)$/i.test(label),
          },
        ]);
      }
    };
    if (state) visit(state, "");
    else rows.push(["状態", "未登録"]);
    return this.table(["項目", "値"], rows);
  }
  locks(registry: { holders: HeldLock[]; waiters: Waiter[] }, timezone?: string): string {
    const rows: Cell[][] = [];
    for (const [name, entries] of [
      ["保持中", registry.holders],
      ["待機中", registry.waiters],
    ] as const)
      for (const entry of entries)
        rows.push([
          { text: name, tone: name === "保持中" ? "active" : "pending" },
          entry.resource,
          `#${entry.issue}`,
          String(entry.pid),
          this.time(entry.since, timezone),
          { text: "workspace" in entry ? (entry.workspace ?? "-") : "-", path: true },
          { text: entry.suspendedShared ? "shared 一時停止" : "-", tone: "muted" },
        ]);
    return this.table(["状態", "資源", "Issue", "PID", "開始時刻", "workspace", "補足"], rows);
  }
  logs(events: Event[], timezone?: string, locations: ReadonlyMap<number, IssueLocation> = new Map()): string {
    if (!events.length) return this.tone("(ログなし)", "muted");
    return events
      .map((e) => {
        const header = `${this.time(e.at, timezone)}  ${e.issue ? `#${e.issue}` : "全体"}  ${e.step ?? "-"}  ${e.event}${e.dryRun ? " [dry-run]" : ""}`;
        const content = relativeArtifacts(plain(e.message), locations.get(e.issue));
        return this.prose(header, eventTone(e.event)) + "\n" + this.prose(content, eventTone(e.event), "  ");
      })
      .join("\n\n");
  }
  notification(msg: Parameters<Notifier["notify"]>[0], link?: IssueLink): string {
    if (msg.gate)
      return `${this.prose(`承認待ち: #${msg.issue} ${msg.gate.name}`, "pending")}\n${this.table(
        ["項目", "内容"],
        [
          ["Issue", { text: `#${msg.issue}`, href: link?.(msg.issue) }],
          ["gate", { text: msg.gate.name, tone: "pending" }],
          ["確かめること", { text: msg.gate.summary, prose: true }],
          [
            "成果物",
            {
              text: msg.gate.artifacts
                .map((file) =>
                  relativeArtifacts(
                    file,
                    msg.gate!.issueDir ? { dir: msg.gate!.issueDir, issue: msg.issue } : undefined,
                  ),
                )
                .join("\n"),
              path: true,
            },
          ],
          [
            msg.gate.command.startsWith("flow approve ") ? "承認コマンド" : "次の操作",
            { text: msg.gate.command, prose: true },
          ],
        ],
      )}`;
    return this.prose(
      `[${msg.level}] #${msg.issue} ${msg.title}\n${msg.body}`,
      msg.level === "error" ? "error" : msg.level === "action" ? "pending" : "muted",
    );
  }
}
