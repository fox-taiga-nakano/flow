import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { outputWriter } from "../../src/cli/stdio.js";
import { temp } from "../helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
const brokenPipe = () => Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

it.each(["sync", "async"])("ignores %s EPIPE, stops further writes and signals once without exiting", async (mode) => {
  const stream = new EventEmitter();
  const write = vi.fn(() => {
    if (mode === "sync") throw brokenPipe();
    queueMicrotask(() => stream.emit("error", brokenPipe()));
    return false;
  });
  Object.assign(stream, { write });
  const writer = outputWriter(stream as unknown as NodeJS.WritableStream);
  const abort = vi.fn();
  writer.signal.addEventListener("abort", abort);
  writer.write("first");
  await Promise.resolve();
  writer.write("second");
  stream.emit("error", brokenPipe());
  expect(write).toHaveBeenCalledTimes(1);
  expect(writer.signal.aborted).toBe(true);
  expect(abort).toHaveBeenCalledTimes(1);
});

it.each(["sync", "async"])("preserves unrelated %s output errors", (mode) => {
  const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  const stream = new EventEmitter();
  Object.assign(stream, {
    write: () => {
      if (mode === "sync") throw error;
    },
  });
  const writer = outputWriter(stream as unknown as NodeJS.WritableStream);
  expect(() => (mode === "sync" ? writer.write("message") : stream.emit("error", error))).toThrow(error);
  expect(writer.signal.aborted).toBe(false);
});

async function run(mode: string, target: "stdout" | "stderr", piped: boolean) {
  const root = await temp();
  dirs.push(root);
  const fixture = path.resolve(import.meta.dirname, "../.build/test/fixtures/epipe-cli.mjs");
  // All positional parameters are passed as shell argv, never interpolated.
  // pipefail checks the producer's status too; closing stderr leaves stdout available.
  const script = piped
    ? target === "stdout"
      ? 'set -o pipefail; "$@" | head -1'
      : 'set -o pipefail; "$@" 2>&1 1>/dev/null | head -1'
    : '"$@"';
  const result = spawnSync("bash", ["-c", script, "epipe-test", process.execPath, fixture, root, mode, target], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toMatch(/write EPIPE|Unhandled|node:events|\bat .*\.js:\d+/);
  const finished = JSON.parse(await fs.readFile(path.join(root, "finished.json"), "utf8"));
  if (piped) {
    expect(finished.closed).toBe(true);
    if (["tick", "run", "approve"].includes(mode)) expect(finished.observedBrokenDuringAction).toBe(true);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  }
  // Read back every persistent file, including actual state/index/locks/events.
  for (const entry of await fs.readdir(root, { recursive: true })) {
    const file = path.join(root, entry);
    if (!(await fs.stat(file)).isFile()) continue;
    expect(file).not.toMatch(/\.(tmp|pid)$/);
    if (file.endsWith(".json")) JSON.parse(await fs.readFile(file, "utf8"));
    if (file.endsWith(".ndjson"))
      for (const line of (await fs.readFile(file, "utf8")).trim().split("\n")) JSON.parse(line);
  }
  return finished;
}

it.each(["status", "logs", "help", "follow"])("%s | head -1 exits quietly when stdout closes", async (mode) => {
  await run(mode, "stdout", true);
});
it.each(["tick", "approve"])(
  "finishes %s state, effects, locks and logs after stdout/stderr close mid-action",
  async (mode) => {
    const normal = await run(mode, "stdout", false);
    for (const target of ["stdout", "stderr"] as const) {
      const piped = await run(mode, target, true);
      const { closed: _closed, observedBrokenDuringAction: _observed, ...durable } = piped;
      const { closed: _normalClosed, observedBrokenDuringAction: _normalObserved, ...baseline } = normal;
      expect(durable).toEqual(baseline);
      if (mode === "tick") {
        expect(piped.states).toHaveLength(2);
        expect(piped.states.every((s: { status: string }) => s.status === "running")).toBe(true);
        expect(piped.states[0].effects).toContain("repro:1:initial-prompt");
        expect(piped.locks.holders).toHaveLength(4);
      } else {
        expect(piped.states[0].effects).toContain("refine:1:on_approve");
        expect(piped.states[0].inflight).toBeNull();
        expect(piped.states[0].pendingResult).toBeNull();
        expect(piped.stages[0]).toEqual([1, "Issue更新済"]);
        expect(piped.locks.holders.map((h: { resource: string }) => h.resource)).toEqual(piped.states[0].locks);
        expect(piped.events.at(-1).event).toBe("approve");
      }
    }
  },
);
it("run | head -1 completes its current tick and releases the run mutex without waiting 60 seconds", async () => {
  const result = await run("run", "stdout", true);
  expect(result.states.every((s: { status: string }) => s.status === "running")).toBe(true);
});
it("the actual CLI entry point keeps argument errors nonzero when its stderr pipe closes", () => {
  const cli = path.resolve(import.meta.dirname, "../../dist/main.mjs");
  const result = spawnSync(
    "bash",
    ["-c", 'set -o pipefail; "$@" 2>&1 1>/dev/null | head -1', "epipe-test", process.execPath, cli, "--unknown"],
    { encoding: "utf8", timeout: 5000 },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain("EPIPE");
});
it("the actual CLI help entry point supports head -1 with exit code zero", () => {
  const cli = path.resolve(import.meta.dirname, "../../dist/main.mjs");
  const result = spawnSync(
    "bash",
    ["-c", 'set -o pipefail; "$@" | head -1', "epipe-test", process.execPath, cli, "--help"],
    { encoding: "utf8", timeout: 5000 },
  );
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
});
