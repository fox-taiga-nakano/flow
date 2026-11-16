import { promises as fs } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import { describe, expect, it } from "vite-plus/test";

import { showStatus } from "../src/cli/runtime.js";
import type { Event } from "../src/core/events.js";
import { atomic } from "../src/core/files.js";
import { initialState } from "../src/core/state.js";
import { wrapText } from "../src/display-text.js";
import { Output } from "../src/output.js";
import { harness } from "./helpers.js";

const message =
  "従業員サイトの DateInputField を確認し、onClear・clearable・clearButtonAriaLabel を整理する。RangeDatePicker と勤務区分マスタの動作も確認してください。 ".repeat(
    3,
  );
const event: Event = { at: "2026-10-23T03:00:00Z", issue: 2261, step: "refine", event: "action", message };
function linesFit(text: string, columns: number) {
  for (const line of stripVTControlCharacters(text).split("\n"))
    expect(stringWidth(line), JSON.stringify(line)).toBeLessThanOrEqual(columns);
}
const flatten = (text: string, indent = 0) =>
  text
    .split("\n")
    .map((line) => line.slice(indent))
    .join("");

describe("terminal-width-aware shared prose", () => {
  it.each([40, 80, 118])("fits every indented log, notification, detail and warning line in %i columns", (columns) => {
    const stream = { isTTY: true, columns };
    const view = new Output({ stream, env: {} });
    expect(view.columns).toBe(columns);
    const state = { ...initialState(2261), initialPrompt: message };
    for (const text of [
      view.logs([event]),
      view.notification({
        issue: 2261,
        title: "承認待ち",
        body: message,
        level: "action",
        gate: {
          name: "issue_push",
          summary: message,
          artifacts: ["issue.md"],
          command: "flow approve 2261 issue_push",
        },
      }),
      view.notification({ issue: 2261, title: "補足", body: message, level: "info" }),
      view.details(state),
      view.prose(message, "error"),
    ])
      linesFit(text, columns);
    const contents = stripVTControlCharacters(view.logs([event]))
      .split("\n")
      .filter((line) => line.startsWith("  "));
    expect(contents.every((line) => stringWidth(line) <= columns)).toBe(true);
    expect(contents.map((line) => line.slice(2)).join("")).toBe(message);
    expect(contents.join("\n")).not.toContain("…");
    for (const word of ["DateInputField", "onClear", "clearable", "clearButtonAriaLabel", "RangeDatePicker"])
      expect(
        contents.some((line) => line.includes(word)),
        word,
      ).toBe(true);
  });
  it("fits the complete status detail including previous-plan notes into 40 columns", async () => {
    const h = await harness();
    try {
      h.workflow.gates.start = "manual";
      await h.o.tick();
      const state = (await h.o.states.read(1))!;
      state.gate!.summary = message;
      await h.o.save(state);
      await atomic(h.o.paths.plan, await h.o.rows([state], h.candidates));
      const output: string[] = [];
      await showStatus(
        h.o,
        h.o.paths,
        1,
        false,
        (text) => output.push(text),
        new Output({ stream: { isTTY: true, columns: 40 }, env: {} }),
      );
      linesFit(output.join("\n"), 40);
    } finally {
      await fs.rm(h.dir, { recursive: true, force: true });
    }
  });
  it("re-reads the live stream width after a pane resize instead of freezing it at construction", () => {
    const stream = { isTTY: true, columns: 118 };
    const view = new Output({ stream, env: {} });
    linesFit(view.logs([event]), 118);
    for (const width of [40, 80, 118]) {
      stream.columns = width;
      expect(view.columns).toBe(width);
      linesFit(view.logs([event]), width);
    }
  });
  it.each([undefined, 0, NaN, Infinity])("uses 80 columns for a TTY without a usable width (%s)", (columns) => {
    const view = new Output({ stream: { isTTY: true, columns }, env: { COLUMNS: "999" } });
    expect(view.columns).toBe(80);
    linesFit(view.logs([event]), 80);
  });
  it("uses the documented 120-column fallback for non-TTY output and never adds ANSI", () => {
    const view = new Output({ stream: { isTTY: false, columns: 118 }, env: { FORCE_COLOR: "1", COLUMNS: "999" } });
    expect(view.columns).toBe(120);
    const output = view.logs([event]);
    expect(stripVTControlCharacters(output)).toBe(output);
    linesFit(output, 120);
  });
  it.each([40, 80, 118])("subtracts the display width of indentation exactly at %i columns", (columns) => {
    const text = "あ".repeat(columns * 2);
    const wrapped = wrapText(text, columns, "  ");
    linesFit(wrapped, columns);
    expect(stringWidth(wrapped.split("\n")[0]!)).toBe(columns);
    expect(flatten(wrapped, 2)).toBe(text);
  });
  it.each([40, 80, 118])("keeps ASCII words intact at a nearly-full line in %i columns", (columns) => {
    const source = "あ".repeat(Math.floor((columns - 2) / 2) - 2) + "onClear・clearButtonAriaLabel";
    const wrapped = wrapText(source, columns, "  ");
    linesFit(wrapped, columns);
    expect(flatten(wrapped, 2)).toBe(source);
    expect(wrapped.split("\n").some((line) => line.includes("onClear"))).toBe(true);
    expect(wrapped.split("\n").some((line) => line.includes("clearButtonAriaLabel"))).toBe(true);
  });
  it("breaks at punctuation while retaining ASCII identifiers and repeated whitespace", () => {
    const source = "hello-world/onClear・clearable、A_B123  next\n  次の行";
    const wrapped = wrapText(source, 16, "  ");
    linesFit(wrapped, 16);
    for (const word of ["hello", "world", "onClear", "clearable", "A_B123", "next"]) expect(wrapped).toContain(word);
    expect(
      wrapped
        .split("\n")
        .map((line) => line.slice(2))
        .join(""),
    ).toBe(source.replaceAll("\n", ""));
  });
  it("splits inside a word only when the entire word exceeds the available width", () => {
    const word = "A".repeat(100);
    const wrapped = wrapText(word, 40, "  ");
    linesFit(wrapped, 40);
    expect(flatten(wrapped, 2)).toBe(word);
    expect(wrapped.split("\n")).toHaveLength(3);
  });
  it("preserves grapheme clusters with mixed Japanese, emoji and combining marks", () => {
    const text = "👩‍💻か\u3099日本語 clearable・".repeat(8);
    const wrapped = wrapText(text, 40, "  ");
    linesFit(wrapped, 40);
    expect(flatten(wrapped, 2)).toBe(text);
    expect(wrapped).not.toMatch(/か\n|👩\n/u);
  });
  it.each([40, 80, 118])("uses the same lossless word wrapping within a table cell at %i columns", (columns) => {
    const output = new Output({ stream: { isTTY: true, columns }, env: {} }).table(
      ["項目", "値"],
      [["説明", { text: message, prose: true }]],
    );
    linesFit(output, columns);
    const text = stripVTControlCharacters(output);
    expect(text).not.toContain("…");
    const contents = text
      .split("\n")
      .filter((line) => line.startsWith("│") && !line.includes("項目"))
      .map((line) => line.split("│")[2]!)
      .join("")
      .replaceAll(/\s/g, "");
    expect(contents).toBe(message.replaceAll(/\s/g, ""));
  });
});
