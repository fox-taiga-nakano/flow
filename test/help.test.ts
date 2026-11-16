import { CommanderError } from "commander";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vite-plus/test";

import { createProgram } from "../src/cli/commands.js";
import { summaries } from "../src/cli/help.js";
import type { CliServices } from "../src/cli/runtime.js";

it("Commander renders usage, Japanese descriptions, examples and gates without opening adapters", async () => {
  for (const command of Object.keys(summaries)) {
    let text = "";
    const open = vi.fn();
    const program = createProgram({
      open,
      output: (s: string) => {
        text += s;
      },
      error: vi.fn(),
    } as unknown as CliServices);
    await expect(program.parseAsync([command, "--help"], { from: "user" })).rejects.toMatchObject({ exitCode: 0 });
    expect(text).toContain("使い方:");
    expect(text).toContain("オプション:");
    expect(text).toContain("例:");
    expect(text).toContain("gate");
    expect(open).not.toHaveBeenCalled();
  }
});
it("native help and --help render identical command help", async () => {
  async function help(args: string[]) {
    let text = "";
    const p = createProgram({
      output: (s: string) => {
        text += s;
      },
      error: vi.fn(),
    } as unknown as CliServices);
    try {
      await p.parseAsync(args, { from: "user" });
    } catch (e) {
      if (!(e instanceof CommanderError) || e.exitCode !== 0) throw e;
    }
    return text;
  }
  expect(await help(["help", "approve"])).toBe(await help(["approve", "--help"]));
  expect(await help(["lock", "help", "acquire"])).toBe(await help(["lock", "acquire", "--help"]));
  expect(await help(["approve", "--help"])).toContain("base_changed=keep|retarget");
  expect(await help(["logs", "--help"])).toContain("-f, --follow");
  expect(await help(["run", "--help"])).toContain("既定: 60");
});
it("all help and error categories use Japanese labels and the expected process exit codes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flow-help-"));
  const cli = path.resolve(import.meta.dirname, "../dist/main.mjs");
  const english =
    /Usage:|Options:|Arguments:|Commands:|Global Options:|error:|unknown option|unknown command|missing required|too many arguments|Did you mean|default:|choices:|display help|\[options\]|\[command\]/;
  const good = [
    ["--help"],
    ["help"],
    ["help", "approve"],
    ["approve", "--help"],
    ["tick", "--help"],
    ["lock", "--help"],
    ["lock", "help", "acquire"],
    ["lock", "acquire", "--help"],
    ["lock", "release", "--help"],
    ["lock", "list", "--help"],
    ["logs", "--help"],
    ["run", "--interval", "60", "--help"],
    ["tick", "--unknown", "--help"],
  ];
  const bad = [
    ["--unknown"],
    ["wat"],
    ["tick", "--unknown"],
    ["approve"],
    ["approve", "wrong"],
    ["run", "--interval"],
    ["run", "--interval", "bad"],
    ["lock"],
    ["lock", "acquire", "db:exclusive"],
    ["lock", "acquire", "db:exclusive", "--issue", "bad"],
    ["lock", "list", "extra"],
    ["lock", "release", "db:shared", "--issue", "1", "--wait"],
    ["tick", "extra"],
    ["logs", "--date", "bad"],
    ["logs", "--date", "2026-02-30"],
    ["logs", "--days", "0"],
    ["logs", "--date", "2026-10-21", "--days", "2"],
    ["approve", "1", "--choice", "bad"],
    ["help", "wat"],
    ["logs", "--f"],
  ];
  try {
    for (const [groups, code] of [
      [good, 0],
      [bad, 1],
    ] as const)
      for (const args of groups) {
        const outFile = path.join(dir, "stdout");
        const errFile = path.join(dir, "stderr");
        const out = openSync(outFile, "w");
        const err = openSync(errFile, "w");
        const result = spawnSync(process.execPath, [cli, ...args], { stdio: ["ignore", out, err] });
        closeSync(out);
        closeSync(err);
        const stdout = readFileSync(outFile, "utf8"),
          stderr = readFileSync(errFile, "utf8");
        expect(result.status, JSON.stringify(args) + "\n" + stdout + stderr).toBe(code);
        expect(stdout + stderr).not.toMatch(english);
        if (code === 0) {
          expect(stdout).toContain("使い方:");
          expect(stderr).toBe("");
        } else {
          expect(stdout).toBe("");
          expect(stderr).toContain("引数または実行のエラー:");
          expect(stderr).toContain("使い方:");
        }
      }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
