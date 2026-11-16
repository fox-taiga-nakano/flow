import { Command } from "commander";
import { stripVTControlCharacters } from "node:util";
import { expect, it, vi } from "vite-plus/test";

import { createProgram } from "../src/cli/commands.js";
import { localize, summaries } from "../src/cli/help.js";
import type { CliServices } from "../src/cli/runtime.js";

const io = { output: vi.fn(), error: vi.fn() };
function program() {
  return createProgram(io as unknown as CliServices);
}

it.each([
  ["", 0],
  ["flow --help", 11],
  ["[オプション]", 12],
  ["ＡＢ！", 6],
  ["한글", 4],
  ["𠀀", 2],
  ["e\u0301", 1],
  ["\u0301", 0],
  ["か\u3099", 2],
  ["\u200b\u200d\u2060\ufe0f", 0],
  ["\u001b[31m漢字\u001b[0m", 4],
  ["\u001b]8;;https://example.test\u001b\\設定\u001b]8;;\u001b\\", 4],
  ["👩‍💻", 2],
  ["Ω", 1],
  ["\n\t\u0000", 0],
] as const)("counts terminal cells for %j", (text, expected) => {
  expect(program().createHelp().displayWidth(text)).toBe(expected);
});

// Independent oracle for the ASCII/Japanese terms in our CLI and the wrapping fixtures.
// It does not use the production displayWidth hook or string-width.
function columns(text: string): number {
  const graphemes = new Intl.Segmenter("ja", { granularity: "grapheme" });
  return Array.from(graphemes.segment(stripVTControlCharacters(text)), ({ segment }) => segment).reduce((sum, char) => {
    if (/\p{Mark}|\p{Default_Ignorable_Code_Point}|\p{Control}/u.test(char)) return sum;
    return sum + (/^[\x20-\x7e]$/.test(char) ? 1 : 2);
  }, 0);
}
function terms(command: Command) {
  const h = command.createHelp();
  return [
    { section: "引数", terms: h.visibleArguments(command).map((a) => h.styleArgumentTerm(h.argumentTerm(a))) },
    { section: "オプション", terms: h.visibleOptions(command).map((o) => h.styleOptionTerm(h.optionTerm(o))) },
    {
      section: "コマンド一覧",
      terms: h.visibleCommands(command).map((c) => h.styleSubcommandTerm(h.subcommandTerm(c))),
    },
  ];
}
function checkColumns(command: Command) {
  const sections = terms(command);
  const descriptionColumn = Math.max(...sections.flatMap((s) => s.terms.map(columns))) + 4;
  const lines = stripVTControlCharacters(command.helpInformation()).split("\n");
  for (const section of sections) {
    for (const styledTerm of section.terms) {
      const term = stripVTControlCharacters(styledTerm);
      const line = lines.find((l) => l.startsWith(`  ${term}  `));
      expect(line, `${command.name()} / ${section.section} / ${term}`).toBeDefined();
      const rest = line!.slice(2 + term.length);
      const padding = /^ +/.exec(rest)![0];
      expect(columns(line!.slice(0, 2 + term.length + padding.length)), `${command.name()} / ${term}`).toBe(
        descriptionColumn,
      );
    }
  }
  return descriptionColumn;
}
const commands = [
  [],
  ...Object.keys(summaries).map((name) => [name]),
  ["lock", "acquire"],
  ["lock", "release"],
  ["lock", "list"],
];
it.each(commands.map((names) => [names]))("aligns every description column for flow %j", (names) => {
  let command = program();
  for (const name of names) command = command.commands.find((c) => c.name() === name)!;
  checkColumns(command);
  for (const line of command
    .helpInformation()
    .split("\n")
    .filter((l) => l.startsWith("  ")))
    expect(columns(line), line).toBeLessThanOrEqual(100);
});

it.each([80, 100])(
  "wraps Japanese descriptions at helpWidth %i using cells and preserves ANSI alignment",
  (helpWidth) => {
    const description = Array(30).fill("日本語").join(" ");
    const command = localize(new Command("表示"), io)
      .description(description)
      .argument("<入力>", description)
      .option("--値 <番号>", description)
      .helpCommand("help [command]", "コマンドの使い方を表示");
    command.configureHelp({
      ...command.configureHelp(),
      helpWidth,
      styleOptionTerm: (term) => `\u001b[36m${term}\u001b[0m`,
    });
    command.command("詳細").description(description).option("--all", "全件");
    const descriptionColumn = checkColumns(command);
    const lines = stripVTControlCharacters(command.helpInformation()).split("\n");
    for (const line of lines) expect(columns(line), line).toBeLessThanOrEqual(helpWidth);
    const firstOptionLine = lines.find((line) => line.startsWith("  --値 "))!;
    const wordsPerLine = Math.floor((helpWidth - descriptionColumn + 1) / 7); // 日本語=6 cells, separating space=1.
    expect(firstOptionLine.match(/日本語/g)).toHaveLength(wordsPerLine);
    const continuations = lines.filter((line) => line.startsWith(" ".repeat(descriptionColumn) + "日本語"));
    expect(continuations.length).toBeGreaterThan(0);
    for (const line of continuations) expect(columns(/^ +/.exec(line)![0])).toBe(descriptionColumn);
  },
);
