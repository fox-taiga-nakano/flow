import { EventEmitter } from "node:events";
import { describe, expect, it } from "vite-plus/test";

import { LiveFrame } from "../src/cli/live-frame.js";
import { changedFields, runFrame } from "../src/cli/run-frame.js";
import { outputWriter } from "../src/cli/stdio.js";
import type { StatusRow } from "../src/core/orchestrator.js";
import { Output } from "../src/output.js";

const CLEAR = "\x1b[H\x1b[2J\x1b[3J";
function screen(columns = 40, rows = 10) {
  const writes: string[] = [];
  const stream = Object.assign(new EventEmitter(), { write: (text: string) => void writes.push(text) });
  const writer = outputWriter(stream as unknown as NodeJS.WritableStream);
  const terminal = Object.assign(new EventEmitter(), { columns, rows });
  return { writes, writer, terminal, frame: new LiveFrame(writer, terminal) };
}

describe("LiveFrame", () => {
  it("erases once, then rewrites only the lines that changed", () => {
    const s = screen();
    s.frame.render("表 1\n表 2\n次回まで 3 秒");
    expect(s.writes[0]).toContain(CLEAR);
    expect(s.writes[0]).toContain("\x1b[?25l");
    s.frame.render("表 1\n表 2\n次回まで 2 秒");
    expect(s.writes[1]).not.toContain(CLEAR);
    expect(s.writes[1]).toContain("\x1b[3;1H\x1b[2K次回まで 2 秒");
    expect(s.writes[1]).not.toContain("表 1");
    expect(s.writes[1]?.startsWith("\x1b[?2026h")).toBe(true);
    expect(s.writes[1]?.endsWith("\x1b[?2026l")).toBe(true);
  });
  it("erases what is left below a shorter frame", () => {
    const s = screen();
    s.frame.render("a\nb\nc");
    s.frame.render("a\nc");
    expect(s.writes[1]).toContain("\x1b[2;1H\x1b[2Kc");
    expect(s.writes[1]).toContain("\x1b[3;1H\x1b[J");
  });
  it("repaints in full when the frame is taller than the screen or wraps, and after invalidate", () => {
    const tall = screen(40, 3);
    tall.frame.render("a\nb");
    tall.frame.render("a\nb\nc\nd");
    expect(tall.writes[1]).toContain(CLEAR);
    tall.frame.render("a\nb");
    expect(tall.writes[2]).toContain(CLEAR);
    const narrow = screen(4, 10);
    narrow.frame.render("ab");
    narrow.frame.render("あいうえ");
    expect(narrow.writes[1]).toContain(CLEAR);
    const resized = screen();
    resized.frame.render("a");
    resized.frame.invalidate();
    resized.frame.render("a");
    expect(resized.writes[1]).toContain(CLEAR);
  });
  it("collects what the tick prints until released, and gives the cursor back once on close", () => {
    const s = screen();
    const notices: string[] = [];
    const release = s.frame.capture((text) => notices.push(text));
    s.writer.write("[action] #4004 承認待ち");
    release();
    s.writer.write("after");
    expect(notices).toEqual(["[action] #4004 承認待ち"]);
    expect(s.writes).toEqual(["after\n"]);
    s.frame.render("a");
    s.frame.close();
    s.frame.close();
    s.frame.render("b");
    expect(s.writes.slice(2)).toEqual(["\n\x1b[?25h"]);
  });
  it("forwards resize until unsubscribed", () => {
    const s = screen();
    let count = 0;
    const off = s.frame.onResize(() => count++);
    s.terminal.emit("resize");
    off();
    s.terminal.emit("resize");
    expect(count).toBe(1);
  });
});

const row = (issue: number, status: string, gate: string | null = null): StatusRow => ({
  issue,
  title: "",
  stage: "未着手",
  step: "repro",
  status,
  gate,
  agent: null,
  slot: null,
  elapsed: 0,
});
describe("run frame", () => {
  it("marks the fields a tick changed and every field of a new Issue, nothing on the first tick", () => {
    expect(changedFields(undefined, [row(1, "idle")]).size).toBe(0);
    const changed = changedFields(
      [row(1, "idle"), row(2, "idle")],
      [row(1, "waiting_gate", "repro"), row(2, "idle"), row(3, "idle")],
    );
    expect(changed.get(1)).toEqual(new Set(["status", "gate"]));
    expect(changed.has(2)).toBe(false);
    expect(changed.get(3)).toEqual(new Set(["stage", "step", "status", "gate"]));
    const view = new Output({ isTTY: true, columns: 120, env: {} });
    expect(view.status([row(1, "waiting_gate", "repro")], undefined, undefined, changed)).toContain("\x1b[4m");
    expect(view.status([row(2, "idle")], undefined, undefined, changed)).not.toContain("\x1b[4m");
  });
  it("shows the notices, table, approvals and a countdown that only the last line changes", () => {
    const view = new Output({ isTTY: false, columns: 120 });
    const model = {
      rows: [{ ...row(4004, "waiting_gate", "cleanup"), answer: "flow approve 4004 cleanup" }],
      notices: ["[action] #4004 承認待ち"],
      changed: new Map(),
      at: 0,
      next: 60_000,
      ticking: false,
      stopped: false,
      interval: 60,
    };
    const first = runFrame(model, view, 17_500).split("\n");
    const later = runFrame(model, view, 18_000).split("\n");
    expect(first[0]).toBe("[action] #4004 承認待ち");
    expect(first.join("\n")).toContain("flow approve 4004 cleanup");
    expect(first.at(-1)).toBe("最終 tick: 1970-01-01 09:00:00 ・ 次回まで 43 秒（60 秒ごと。Ctrl+C で終了）");
    expect(later.at(-1)).toContain("次回まで 42 秒");
    expect(later.slice(0, -1)).toEqual(first.slice(0, -1));
    expect(
      runFrame({ ...model, ticking: true }, view, 0)
        .split("\n")
        .at(-1),
    ).toBe("最終 tick: 1970-01-01 09:00:00 ・ tick 実行中…");
    expect(runFrame({ ...model, at: undefined, notices: [], ticking: true }, view, 0)).toBe("tick 実行中…");
  });
});
