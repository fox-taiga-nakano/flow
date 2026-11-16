import { promises as fs } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import pc from "picocolors";
import stringWidth from "string-width";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { CommandNotifier } from "../../src/adapters/notifier.js";
import { createProgram } from "../../src/cli/commands.js";
import { Output, nowLabel, stateTone } from "../../src/cli/output.js";
import type { CliServices } from "../../src/cli/runtime.js";
import type { Event } from "../../src/core/events.js";
import { atomic } from "../../src/core/files.js";
import { type Orchestrator, type StatusRow, gateAnswer } from "../../src/core/orchestrator.js";
import { FlowPaths } from "../../src/core/paths.js";
import { initialState } from "../../src/core/state.js";
import { issueLink, parseWorkflow } from "../../src/core/workflow.js";
import { config, harness, temp } from "../helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
const at = "2026-10-22T15:04:05.123Z";
const event: Event = { at, issue: 1, step: "repro", event: "action", message: "再現手順と成果物を確認してください" };
const row: StatusRow = {
  issue: 1,
  title: "日本語の案件",
  stage: "未着手",
  step: "repro",
  status: "waiting_gate",
  gate: "repro_result",
  agent: "flow-repro-1",
  slot: 1,
  elapsed: 63,
};
const state = () => ({
  ...initialState(1, at),
  step: "repro",
  status: "waiting_gate" as const,
  startedAt: at,
  updatedAt: at,
  gate: { name: "repro_result", phase: "after" as const, summary: "成果物を確認", artifacts: ["repro.md"], since: at },
  agent: { runner: "herdr", name: "flow-repro-1", paneId: "w-test:p1" },
});

function plainView(columns = 120) {
  return new Output({ isTTY: false, columns, env: {} });
}

it("formats objects and circular values without losing errors", () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  expect(plainView().prose({ reason: "failure" })).toContain("reason");
  expect(plainView().prose(circular)).toContain("Circular");
  expect(plainView().prose(new Error("failure"))).toContain("Error: failure");
});
function checkWidth(text: string, width: number) {
  const lines = stripVTControlCharacters(text).split("\n");
  for (const line of lines) expect(stringWidth(line), line).toBeLessThanOrEqual(width);
  // Border/column padding is provided by cli-table3; all table lines fill the same width.
  const tableLines = lines.filter((line) => /^[┌├└│]/u.test(line));
  if (tableLines.length) expect(new Set(tableLines.map((line) => stringWidth(line))).size).toBe(1);
}

describe("shared tables and colors", () => {
  it.each([12, 24, 40, 80, 100, 120])(
    "fits Japanese, long identifiers and newlines within %i terminal cells",
    (width) => {
      const view = plainView(width);
      const text = view.status([
        {
          ...row,
          gate: "長い確認項目と非常に長い日本語の説明".repeat(3),
          agent: "flow-repro-agent-with-long-name",
          error: "失敗理由\n" + "説明".repeat(20),
          planned: true,
        },
      ]);
      checkWidth(text, width);
      expect(text).not.toContain("\t");
      expect(text).toContain("#1");
    },
  );
  it.each([24, 80, 120])("fits detail, lock, log and empty output at %i columns", (width) => {
    const view = plainView(width);
    for (const text of [
      view.details(state()),
      view.locks({
        holders: [
          {
            resource: "db:exclusive",
            issue: 1,
            pid: 123,
            since: at,
            workspace: "/a/日本語/" + "very-long-directory/".repeat(4),
          },
        ],
        waiters: [],
      }),
      view.logs([{ ...event, message: "行一\n" + "行二".repeat(30) }]),
      view.status([]),
    ])
      checkWidth(text, width);
  });
  it.each([24, 80, 120])("TTY decoration preserves plain table contents and width at %i columns", (columns) => {
    const tty = new Output({ isTTY: true, columns, env: {} });
    const nonTty = plainView(columns);
    const rows = [{ ...row, gate: "確認項目".repeat(15), error: "long-identifier".repeat(20) }];
    const colored = tty.status(rows);
    expect(stripVTControlCharacters(colored)).toBe(nonTty.status(rows));
    checkWidth(colored, columns);
  });
  it("aligns Japanese and ASCII borders at equal display columns", () => {
    const text = plainView().table(
      ["Issue", "段階"],
      [
        ["#1", "未着手"],
        ["#1000", "検証済"],
        ["#2", "対象外"],
      ],
    );
    const lines = text.split("\n").filter((line) => line.startsWith("│"));
    const positions = lines.map((line) =>
      [...line.matchAll(/│/g)].map((match) => stringWidth(line.slice(0, match.index))),
    );
    expect(positions.every((p) => JSON.stringify(p) === JSON.stringify(positions[0]))).toBe(true);
  });
  it.each([
    ["waiting_gate", "pending"],
    ["running", "active"],
    ["failed", "error"],
    ["done", "success"],
    ["stopped", "inactive"],
  ] as const)("gives %s a consistent semantic color", (status, tone) => {
    const view = new Output({ isTTY: true, columns: 120, env: {} });
    expect(stateTone(status)).toBe(tone);
    expect(view.status([{ ...row, status }])).toContain(view.tone(nowLabel({ ...row, status }), tone));
    expect(view.details({ ...state(), status })).toContain(view.tone(status, tone));
  });
  it("colors excluded stages gray even when the old status says running", () => {
    const view = new Output({ isTTY: true, columns: 120, env: {} });
    expect(view.status([{ ...row, stage: "除外", status: "running" }], "除外")).toContain(
      view.colors.gray(nowLabel({ ...row, stage: "除外", status: "running" }, "除外")),
    );
    expect(view.details({ ...state(), status: "running" }, "Asia/Tokyo", true)).toContain(view.colors.gray("running"));
  });
  it.each([{ NO_COLOR: "1" }, { NO_COLOR: "" }, { NO_COLOR: "0", FORCE_COLOR: "1" }, { TERM: "dumb" }])(
    "has no ANSI on TTY with %j",
    (env) => {
      const view = new Output({ isTTY: true, env });
      const text =
        view.status([row]) +
        view.result("成功") +
        view.notification({ issue: 1, title: "確認", body: "本文", level: "action" });
      expect(stripVTControlCharacters(text)).toBe(text);
    },
  );
  it("never colors pipes even with FORCE_COLOR/CI, and strips incoming terminal escapes", () => {
    const view = new Output({ isTTY: false, env: { FORCE_COLOR: "1", CI: "true" } });
    const text =
      view.status([{ ...row, error: pc.createColors(true).red("外部コマンドのエラー") }]) +
      view.logs([event]) +
      view.result("完了");
    expect(stripVTControlCharacters(text)).toBe(text);
  });
  it("formats timestamps in Japan across a UTC date boundary with no locale commas", () => {
    expect(plainView().time(at)).toBe("2026-10-23 00:04:05");
    expect(plainView().time("2026-10-22T15:00:00Z")).toBe("2026-10-23 00:00:00");
    expect(plainView().time(at, "UTC")).toBe("2026-10-22 15:04:05");
    expect(plainView().time(null)).toBe("-");
    expect(plainView().logs([event])).toContain("2026-10-23 00:04:05");
    expect(plainView().details(state())).not.toContain(at);
  });
  it("distinguishes lock owners and waiting requests without discarding fields", () => {
    const text = plainView(180).locks({
      holders: [
        { resource: "db:exclusive", issue: 1, pid: 42, since: at, suspendedShared: true, workspace: "/project" },
      ],
      waiters: [{ resource: "db:exclusive", issue: 2, pid: 43, since: at }],
    });
    for (const term of [
      "保持中",
      "待機中",
      "#1",
      "#2",
      "42",
      "43",
      "/project",
      "shared 一時停止",
      "2026-10-23 00:04:05",
    ])
      expect(text).toContain(term);
  });
  it("renders notification fields from structured gate data and leaves external notification payload plain", async () => {
    const workflow = await config();
    workflow.notifier.command = "notify {body}";
    const exec = { run: vi.fn(async () => "") };
    const output = vi.fn();
    const notifier = new CommandNotifier(exec, workflow, output, plainView());
    const msg = {
      issue: 1,
      title: "承認待ち: repro_result",
      body: "外部通知用の本文",
      level: "action" as const,
      gate: {
        name: "repro_result",
        summary: "成果物を確認",
        artifacts: ["/issues/1/repro.md"],
        command: "flow approve 1 repro_result",
      },
    };
    workflow.notifier.command = "notify {body} {sound}";
    await notifier.notify(msg);
    expect(exec.run).toHaveBeenCalledWith(expect.objectContaining({ command: "notify '外部通知用の本文' 'request'" }));
    await notifier.notify({ ...msg, level: "info" });
    expect(exec.run).toHaveBeenCalledWith(expect.objectContaining({ command: "notify '外部通知用の本文' 'none'" }));
    workflow.notifier.command = "notify {body}";
    await notifier.notify(msg);
    const text = output.mock.calls[0]![0] as string;
    for (const term of ["Issue", "gate", "確かめること", "成果物", "承認コマンド", "flow approve 1 repro_result"])
      expect(text).toContain(term);
    expect(exec.run).toHaveBeenCalledWith(
      expect.objectContaining({ command: "notify '外部通知用の本文'", mutation: true }),
    );
  });
  it("passes structured gate information from the orchestrator to its notifier", async () => {
    const h = await harness();
    dirs.push(h.dir);
    h.workflow.gates.start = "manual";
    await h.o.tick();
    expect(h.a.notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        issue: 1,
        gate: {
          name: "start",
          summary: expect.any(String),
          artifacts: [h.files.get(1)],
          issueDir: h.files.get(1),
          command: "flow approve 1 start",
        },
      }),
    );
  });
  it("validates the workflow display timezone", async () => {
    const source = await fs.readFile(path.join(import.meta.dirname, "../fixtures/WORKFLOW.md"), "utf8");
    expect(parseWorkflow(source).timezone).toBe("Asia/Tokyo");
    expect(() => parseWorkflow(source.replace("timezone: Asia/Tokyo", "timezone: wrong-zone"))).toThrow("timezone");
    expect(parseWorkflow(source.replace("timezone: Asia/Tokyo\n", "")).timezone).toBeUndefined();
  });
});

async function cli(view = plainView()) {
  const root = await temp();
  dirs.push(root);
  const workflow = await config();
  const o = {
    workflow,
    tick: vi.fn(async () => [{ ...row, planned: true }]),
    control: vi.fn(async () => {}),
    acquireResource: vi.fn(async () => true),
    releaseResource: vi.fn(async () => {}),
    locks: {
      validate: vi.fn(),
      cancel: vi.fn(async () => {}),
      list: vi.fn(async () => ({ holders: [], waiters: [] })),
    },
    a: { tracker: { listCandidates: vi.fn(async () => []) }, stages: { get: vi.fn(async () => "未着手") } },
    states: { numbers: vi.fn(async () => [1]), read: vi.fn(async () => state()) },
    rows: vi.fn(async () => [row]),
    events: { read: vi.fn(async () => [event]), add: vi.fn(async () => {}) },
  };
  const services: CliServices = {
    paths: new FlowPaths(root),
    open: vi.fn(async () => o as unknown as Orchestrator),
    output: vi.fn(),
    error: vi.fn(),
    sleep: vi.fn(async () => {}),
    now: () => 0,
    view,
  };
  return {
    o,
    services,
    run: (args: string[]) => createProgram(services).parseAsync(args, { from: "user" }),
    text: () =>
      vi
        .mocked(services.output)
        .mock.calls.map(([text]) => text)
        .join("\n"),
  };
}
describe("all CLI output paths", () => {
  it.each([["status"], ["status", "1"], ["tick", "--dry-run"], ["lock", "list"]])(
    "prints tables without ANSI for %j",
    async (...args) => {
      const h = await cli();
      await h.run(args);
      expect(h.text()).toContain("┌");
      expect(stripVTControlCharacters(h.text())).toBe(h.text());
      expect(h.text()).not.toContain("\t");
    },
  );
  it("prints logs as unframed records without ANSI", async () => {
    const h = await cli();
    await h.run(["logs"]);
    expect(h.text()).not.toContain("┌");
    expect(h.text()).toContain("2026-10-23 00:04:05  #1  repro  action");
    expect(h.text()).toContain("  " + event.message);
    expect(stripVTControlCharacters(h.text())).toBe(h.text());
  });
  it.each([false, true])(
    "preserves exact status --json output with TTY=%s, including raw timestamps and details",
    async (tty) => {
      const h = await cli(new Output({ isTTY: tty, env: {} }));
      await atomic(h.services.paths.plan, [{ ...row, planned: true }]);
      await h.run(["status", "1", "--json"]);
      expect(vi.mocked(h.services.output).mock.calls).toEqual([
        [JSON.stringify({ rows: [row], details: state(), dir: null }, null, 2)],
      ]);
      expect(h.text()).not.toContain("予定");
      expect(h.text()).toContain(at);
    },
  );
  it.each([
    [["approve", "1", "start"], "承認しました"],
    [["reject", "1", "--reason", "理由\n二行目"], "対象外にしました（理由: 理由 二行目）"],
    [["retry", "1"], "再開待ちにしました"],
    [["stop", "1", "--reason", "確認"], "停止しました（理由: 確認）"],
    [["lock", "acquire", "db:shared", "--issue", "1"], "ロック db:shared を取得しました"],
    [["lock", "release", "db:shared", "--issue", "1"], "ロック db:shared を解放しました"],
  ])("gives a one-line action result for %j", async (args, expected) => {
    const h = await cli();
    await h.run(args as string[]);
    expect(h.text()).toContain(expected as string);
    expect(h.text()).toContain("✔ #1");
    expect(h.text().split("\n")).toHaveLength(1);
  });
  it("streams only fresh log occurrences, preserving identical events, and does not redraw empty polls", async () => {
    const h = await cli();
    h.o.events.read
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([event, event])
      .mockResolvedValue([event, event]);
    vi.mocked(h.services.sleep)
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {})
      .mockRejectedValueOnce(new Error("test end"));
    await expect(h.run(["logs", "--follow"])).rejects.toThrow("test end");
    expect(vi.mocked(h.services.output).mock.calls).toHaveLength(2);
    expect(h.text().split(event.message)).toHaveLength(3);
  });
  it("styles TTY tick and help through the same output context", async () => {
    const h = await cli(new Output({ isTTY: true, columns: 100, env: {} }));
    await h.run(["tick", "--dry-run"]);
    expect(h.text()).toContain(h.services.view!.colors.yellow("承認待ち"));
    expect(h.text()).toContain(
      h.services.view!.colors.dim(
        "dry-run: 状態を変える外部コマンドはすべて SKIPPED。state.json・ロック・段階は未変更。",
      ),
    );
    vi.mocked(h.services.output).mockClear();
    await h.run(["--help"]).catch(() => {});
    expect(h.text()).toContain(h.services.view!.colors.bold("使い方:"));
  });
});
describe("pending gate answers", () => {
  it("names the command for each gate kind, matching the one-time notice", () => {
    expect(gateAnswer(1, "start", "before")).toBe("flow approve 1 start");
    expect(gateAnswer(1, "ng_action", "ng")).toBe("flow approve 1 ng_action --choice copilot|self|stop");
    expect(gateAnswer(1, "base_changed", "base")).toBe("flow approve 1 base_changed --choice keep|retarget");
    expect(gateAnswer(1, "launch_recovery", "recovery")).toBe("flow approve 1 launch_recovery --choice applied|retry");
    expect(gateAnswer(1, "agent_question", "question")).toContain("flow answer 1");
  });
  it("says so when nothing is waiting", () => {
    expect(new Output({ isTTY: false }).answers([])).toBe("承認待ちはありません");
  });
});
describe("Issue links", () => {
  const row: StatusRow = {
    issue: 4004,
    title: "",
    stage: "検証済",
    step: "cleanup",
    status: "waiting_gate",
    gate: "cleanup",
    answer: "flow approve 4004 cleanup",
    agent: null,
    slot: null,
    elapsed: 0,
  };
  const link = issueLink({ vars: { owner: "o", repo: "r" } });
  const osc = "\x1b]8;;https://github.com/o/r/issues/4004\x07";
  it("links the Issue number on a terminal without changing the column layout", () => {
    const tty = new Output({ isTTY: true, columns: 120, env: {} });
    const linked = tty.status([row], "対象外", link);
    expect(linked).toContain(osc);
    expect(stripVTControlCharacters(linked.replaceAll(osc, "").replaceAll("\x1b]8;;\x07", ""))).toBe(
      stripVTControlCharacters(tty.status([row], "対象外")),
    );
    expect(tty.answers([row], link)).toContain(osc);
    expect(
      tty.notification(
        {
          issue: 4004,
          title: "承認待ち",
          body: "",
          level: "action",
          gate: { name: "cleanup", summary: "確認", artifacts: [], command: "flow approve 4004 cleanup" },
        },
        link,
      ),
    ).toContain(osc);
  });
  it("prints plain numbers when piped, dumb, or without a repository", () => {
    expect(new Output({ isTTY: false }).status([row], "対象外", link)).not.toContain("\x1b]8");
    expect(new Output({ isTTY: true, env: { TERM: "dumb" } }).status([row], "対象外", link)).not.toContain("\x1b]8");
    expect(issueLink({ vars: { main: "/x" } })(1)).toBeUndefined();
  });
});
