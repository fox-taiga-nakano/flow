import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it, vi } from "vite-plus/test";

import { createProgram } from "../src/cli/commands.js";
import { localize } from "../src/cli/help.js";
import type { CliServices } from "../src/cli/runtime.js";

const choices = "選べる値: copilot, self, stop, keep, retarget, applied, retry, skip";
const cases = [
  { command: "tick", args: ["tick", "--bogus"], message: "使えないオプションです: --bogus", code: "unknownOption" },
  {
    command: "tick",
    args: ["tick", "extra"],
    message: "引数が多すぎます: extra（指定できる数: 0、受け取った数: 1）",
    code: "excessArguments",
  },
  {
    command: "run",
    args: ["run", "--interval", "abc"],
    message: "--interval の値が不正です: abc（interval は正の秒数です）",
    code: "invalidArgument",
  },
  {
    command: "run",
    args: ["run", "--interval=0"],
    message: "--interval の値が不正です: 0（interval は正の秒数です）",
    code: "invalidArgument",
  },
  {
    command: "run",
    args: ["run", "--interval"],
    message: "オプションの値がありません: --interval <秒>",
    code: "optionMissingArgument",
  },
  {
    command: "status",
    args: ["status", "wrong"],
    message: "[issue] の値が不正です: wrong（正の整数を指定してください）",
    code: "invalidArgument",
  },
  { command: "status", args: ["status", "--bogus"], message: "使えないオプションです: --bogus", code: "unknownOption" },
  { command: "approve", args: ["approve"], message: "引数が足りません: <issue>", code: "missingArgument" },
  {
    command: "approve",
    args: ["approve", "1", "x", "--choice", "nope"],
    message: `--choice の値が不正です: nope（${choices}）`,
    code: "invalidArgument",
  },
  {
    command: "approve",
    args: ["approve", "1", "--choice", "no'pe"],
    message: `--choice の値が不正です: no'pe（${choices}）`,
    code: "invalidArgument",
  },
  {
    command: "approve",
    args: ["approve", "1", "--choice", ""],
    message: `--choice の値が不正です: ""（${choices}）`,
    code: "invalidArgument",
  },
  { command: "reject", args: ["reject"], message: "引数が足りません: <issue>", code: "missingArgument" },
  {
    command: "reject",
    args: ["reject", "wrong"],
    message: "<issue> の値が不正です: wrong（正の整数を指定してください）",
    code: "invalidArgument",
  },
  {
    command: "reject",
    args: ["reject", "1", "--reason"],
    message: "オプションの値がありません: --reason <理由>",
    code: "optionMissingArgument",
  },
  { command: "retry", args: ["retry"], message: "引数が足りません: <issue>", code: "missingArgument" },
  {
    command: "retry",
    args: ["retry", "bad'value"],
    message: "<issue> の値が不正です: bad'value（正の整数を指定してください）",
    code: "invalidArgument",
  },
  { command: "stop", args: ["stop"], message: "引数が足りません: <issue>", code: "missingArgument" },
  {
    command: "stop",
    args: ["stop", "0"],
    message: "<issue> の値が不正です: 0（正の整数を指定してください）",
    code: "invalidArgument",
  },
  {
    command: "stop",
    args: ["stop", "1", "--reason"],
    message: "オプションの値がありません: --reason <理由>",
    code: "optionMissingArgument",
  },
  { command: "lock", args: ["lock"], message: "引数が足りません: <acquire|release|list>", code: "missingArgument" },
  { command: "lock", args: ["lock", "--bogus"], message: "使えないオプションです: --bogus", code: "unknownOption" },
  {
    command: "lock acquire",
    args: ["lock", "acquire", "--issue", "1"],
    message: "引数が足りません: <resource>",
    code: "missingArgument",
  },
  {
    command: "lock acquire",
    args: ["lock", "acquire", "db:shared"],
    message: "必須のオプションがありません: --issue <番号>",
    code: "missingMandatoryOptionValue",
  },
  {
    command: "lock acquire",
    args: ["lock", "acquire", "db:shared", "--issue", "wrong"],
    message: "--issue の値が不正です: wrong（正の整数を指定してください）",
    code: "invalidArgument",
  },
  {
    command: "lock acquire",
    args: ["lock", "acquire", "db:shared", "--issue", "1", "--timeout", "-1"],
    message: "--timeout の値が不正です: -1（timeout は0以上のミリ秒です）",
    code: "invalidArgument",
  },
  {
    command: "lock release",
    args: ["lock", "release", "--issue", "1"],
    message: "引数が足りません: <resource>",
    code: "missingArgument",
  },
  {
    command: "lock release",
    args: ["lock", "release", "db:shared"],
    message: "必須のオプションがありません: --issue <番号>",
    code: "missingMandatoryOptionValue",
  },
  {
    command: "lock release",
    args: ["lock", "release", "db:shared", "--issue"],
    message: "オプションの値がありません: --issue <番号>",
    code: "optionMissingArgument",
  },
  {
    command: "lock release",
    args: ["lock", "release", "db:shared", "--issue", "0"],
    message: "--issue の値が不正です: 0（正の整数を指定してください）",
    code: "invalidArgument",
  },
  {
    command: "lock list",
    args: ["lock", "list", "extra"],
    message: "引数が多すぎます: extra（指定できる数: 0、受け取った数: 1）",
    code: "excessArguments",
  },
  {
    command: "lock list",
    args: ["lock", "list", "--bogus"],
    message: "使えないオプションです: --bogus",
    code: "unknownOption",
  },
  {
    command: "logs",
    args: ["logs", "--date", "2026-02-30"],
    message: "--date の値が不正です: 2026-02-30（日付は実在する YYYY-MM-DD で指定してください）",
    code: "invalidArgument",
  },
  {
    command: "logs",
    args: ["logs", "--days", "0"],
    message: "--days の値が不正です: 0（days は正の整数です）",
    code: "invalidArgument",
  },
  {
    command: "logs",
    args: ["logs", "--date", "2026-10-21", "--days", "2"],
    message: "--date と --days は同時に使えません",
    code: "conflictingOption",
  },
  {
    command: "logs",
    args: ["logs", "--days", "2", "--date", "2026-10-21"],
    message: "--date と --days は同時に使えません",
    code: "conflictingOption",
  },
  {
    command: "validate",
    args: ["validate", "--bogus"],
    message: "使えないオプションです: --bogus",
    code: "unknownOption",
  },
  {
    command: "validate",
    args: ["validate", "extra"],
    message: "引数が多すぎます: extra（指定できる数: 0、受け取った数: 1）",
    code: "excessArguments",
  },
  { command: "", args: ["help", "wat"], message: "知らないコマンドです: wat", code: "help" },
  { command: "lock", args: ["lock", "help", "wat"], message: "知らないコマンドです: wat", code: "help" },
  {
    command: "tick",
    args: ["--choice", "keep", "tick"],
    message: "使えないオプションです: --choice",
    code: "unknownOption",
  },
];
const dir = mkdtempSync(path.join(tmpdir(), "flow-errors-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it.each(cases)("gives details and native help for $args", async ({ args, command, message, code }) => {
  const open = vi.fn();
  const output = vi.fn();
  const errors: string[] = [];
  const p = createProgram({ open, output, error: (text: string) => errors.push(text) } as unknown as CliServices);
  await expect(p.parseAsync(args, { from: "user" })).rejects.toMatchObject({ code: `commander.${code}`, exitCode: 1 });
  expect(open).not.toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
  expect(errors[0]).toBe(`引数または実行のエラー: ${message}`);
  expect(errors.join("\n").match(/^使い方: (.+)$/m)?.[1]).toMatch(
    new RegExp(`^flow${command ? ` ${command}` : ""}(?: \\[| <|$)`),
  );

  // Also exercise main.ts: parse-time errors must reach stderr and exit 1 before any services open.
  const outFile = path.join(dir, "out"),
    errFile = path.join(dir, "err");
  const out = openSync(outFile, "w"),
    err = openSync(errFile, "w");
  const cli = path.resolve(import.meta.dirname, "../dist/main.mjs");
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: ["ignore", out, err] });
  closeSync(out);
  closeSync(err);
  expect(result.status).toBe(1);
  expect(readFileSync(outFile, "utf8")).toBe("");
  const stderr = readFileSync(errFile, "utf8");
  // stderr は表示幅（端末でなければ 120）で折り返されるので、使い方の前までを改行を除いて比べる
  expect(stderr.split("\n使い方")[0]!.replace(/\n/g, "")).toBe(`引数または実行のエラー: ${message}`);
  expect(stderr.match(/^使い方: (.+)$/m)?.[1]).toBe(errors.join("\n").match(/^使い方: (.+)$/m)?.[1]);
  expect(stderr.match(/^使い方:/gm)).toHaveLength(1);
  expect(stderr).not.toMatch(
    /error:|Usage:|Options:|Commands:|Arguments:|Allowed choices|is invalid|argument missing|not specified|cannot be used/,
  );
});

it("localizes native unknownCommand errors with the rejected name", async () => {
  const errors: string[] = [];
  const p = localize(new Command("flow"), { output: vi.fn(), error: (text) => errors.push(text) }).helpCommand(
    "help [command]",
    "コマンドの使い方を表示",
  );
  p.command("known").description("既知のコマンド");
  await expect(p.parseAsync(["wat"], { from: "user" })).rejects.toMatchObject({
    code: "commander.unknownCommand",
    exitCode: 1,
  });
  expect(errors[0]).toBe("引数または実行のエラー: 知らないコマンドです: wat");
  expect(errors[1]).toContain("使い方: flow");
});

it("keeps runtime-error help available after an action begins", async () => {
  const errors: string[] = [];
  const p = createProgram({
    open: vi.fn(async () => {
      throw new Error("設定を読み込めません");
    }),
    output: vi.fn(),
    error: (text: string) => errors.push(text),
  } as unknown as CliServices);
  await expect(p.parseAsync(["validate"], { from: "user" })).rejects.toThrow("設定を読み込めません");
  p.commands.find((c) => c.name() === "validate")!.outputHelp({ error: true });
  expect(errors.join("\n")).toContain("使い方: flow validate");
});

it.each([
  ["nosuch", ""],
  ["statu", "status"],
  ["logk", "lock, logs"],
  ["hepl", "help"],
])("reports unknown command %s with native suggestions and root help", async (name, suggestion) => {
  const open = vi.fn();
  const errors: string[] = [];
  const p = createProgram({
    open,
    output: vi.fn(),
    error: (text: string) => errors.push(text),
  } as unknown as CliServices);
  await expect(p.parseAsync([name], { from: "user" })).rejects.toMatchObject({
    code: "commander.unknownCommand",
    exitCode: 1,
  });
  expect(open).not.toHaveBeenCalled();
  expect(errors[0]).toBe(
    `引数または実行のエラー: 知らないコマンドです: ${name}${suggestion ? `\n候補: ${suggestion}` : ""}`,
  );
  expect(errors.join("\n").match(/^使い方: (.+)$/m)?.[1]).toBe("flow [オプション] [コマンド]");
  const outFile = path.join(dir, "unknown-out"),
    errFile = path.join(dir, "unknown-err");
  const out = openSync(outFile, "w"),
    err = openSync(errFile, "w");
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../dist/main.mjs"), name], {
    stdio: ["ignore", out, err],
  });
  closeSync(out);
  closeSync(err);
  expect(result.status).toBe(1);
  expect(readFileSync(outFile, "utf8")).toBe("");
  expect(readFileSync(errFile, "utf8")).toContain(errors[0]!);
  expect(readFileSync(errFile, "utf8").match(/^使い方: (.+)$/m)?.[1]).toBe("flow [オプション] [コマンド]");
  expect(readFileSync(errFile, "utf8")).not.toMatch(/Did you mean|error:|Usage:|\[issue\] の値/);
});
