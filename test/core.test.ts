import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { atomic, mutex } from "../src/core/files.js";
import { Locks } from "../src/core/locks.js";
import { checkState, initialState } from "../src/core/state.js";
import { render } from "../src/core/template.js";
import { WorkflowLoader, parseWorkflow } from "../src/core/workflow.js";
import { config, temp } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
async function tmp() {
  const d = await temp();
  dirs.push(d);
  return d;
}
describe("workflow and file boundaries", () => {
  it("strict templates quote shell metacharacters and reject missing nested vars", () => {
    expect(render("x {issue.number}", { issue: { number: 5 } })).toBe("x 5");
    expect(render("x {title}", { title: "a'$(touch /oops)" }, true)).toBe("x 'a'\\''$(touch /oops)'");
    expect(() => render("{pr.number}", {})).toThrow("未定義");
    expect(() => render("{value}", { value: {} })).toThrow("値を展開できません");
    expect(() => render("{value}", { value: () => "unsafe" })).toThrow("値を展開できません");
  });
  it("rejects bad config and caches last valid config across processes", async () => {
    const dir = await tmp();
    const file = path.join(dir, "WORKFLOW.md");
    const source = await fs.readFile(path.join(import.meta.dirname, "../test/fixtures/WORKFLOW.md"), "utf8");
    await fs.writeFile(file, source);
    const loader = new WorkflowLoader(file, dir);
    await loader.load();
    await fs.writeFile(file, "bad");
    expect((await new WorkflowLoader(file, dir).load()).warning).toBeTruthy();
    await expect(loader.load(false)).rejects.toThrow("front matter");
    expect(() => parseWorkflow(source.replace("global: 9", "global: 0"))).toThrow("concurrency");
    expect(() => parseWorkflow(source.replace("{last_failure}", "{undefined_value}"))).toThrow("未定義");
    const runner = "  close_on_complete: true\n";
    expect(parseWorkflow(source.replace(runner, `${runner}  commands: {}\n`)).runner).not.toHaveProperty("commands");
    for (const key of ["start", "start_main"])
      expect(() =>
        parseWorkflow(source.replace(runner, `${runner}  commands: { ${key}: "mise wt:agent {name}" }\n`)),
      ).toThrow("廃止");
  });
  it("atomic writes leave no tmp files and reject broken states", async () => {
    const dir = await tmp();
    await Promise.all(Array.from({ length: 10 }, (_, i) => atomic(path.join(dir, "s.json"), { i })));
    expect(JSON.parse(await fs.readFile(path.join(dir, "s.json"), "utf8")).i).toBeTypeOf("number");
    expect((await fs.readdir(dir)).filter((x) => x.endsWith(".tmp"))).toHaveLength(0);
    expect(() => checkState({ ...initialState(1), version: 2 } as never, 1)).toThrow();
  });
  it("mutex prevents duplicate run and reclaims a dead pid", async () => {
    const dir = await tmp();
    const file = path.join(dir, "flow.pid");
    await mutex(file, async () => {
      await expect(mutex(file, async () => {})).rejects.toThrow("別プロセス");
    });
    await fs.writeFile(file, "2147483646");
    await mutex(file, async () => {});
  });
});
describe("resource locks", () => {
  async function locks() {
    const dir = await tmp();
    const w = await config();
    return new Locks(dir, w.locks);
  }
  it("shares reads, excludes writers and atomically rejects a partial batch", async () => {
    const l = await locks();
    expect(await l.acquire(["db:shared"], 1)).toEqual(["db:shared"]);
    expect(await l.acquire(["db:shared"], 2)).toEqual(["db:shared"]);
    expect(await l.acquire(["slot", "db:exclusive"], 3)).toBeNull();
    expect((await l.list()).holders).toHaveLength(2);
  });
  it("temporarily suspends own shared on upgrade, restores it on exclusive release", async () => {
    const l = await locks();
    await l.acquire(["db:shared"], 1);
    expect(await l.acquire(["db:exclusive"], 1)).toEqual(["db:exclusive"]);
    expect((await l.list()).holders[0]?.resource).toBe("db:exclusive");
    await l.release(1, "db:exclusive");
    expect((await l.list()).holders[0]?.resource).toBe("db:shared");
  });
  it("queued exclusive prevents new readers and survives reconstruction", async () => {
    const l = await locks();
    await l.acquire(["db:shared"], 1);
    await l.acquire(["db:shared"], 2);
    await l.queue("db:exclusive", 1);
    expect(await l.acquire(["db:shared"], 3)).toBeNull();
    expect(await l.acquire(["db:exclusive"], 1)).toBeNull();
    await l.release(2);
    const next = new Locks(l.dir, l.config);
    expect(await next.acquire(["db:exclusive"], 1)).toEqual(["db:exclusive"]);
    await next.release(1, "db:exclusive");
    expect((await next.list()).holders[0]?.resource).toBe("db:shared");
  });
  it("respects existing worktree slots and keeps slots until workspace removal", async () => {
    const l = await locks();
    const ws = { key: "existing", path: "/worktree", branch: "b", workspaceId: "w1", slot: 1 };
    expect(await l.acquire(["slot"], 1, [ws])).toEqual(["slot:2"]);
    await l.bindSlot(1, 2, "/other");
    await l.release(1);
    expect((await l.list()).holders[0]?.resource).toBe("slot:2");
    await l.release(1, undefined, true);
    expect((await l.list()).holders).toHaveLength(0);
  });
  it("supports reuse of same slot for same workspace, never another issue", async () => {
    const l = await locks();
    const ws = { key: "a", path: "/a", workspaceId: "w1", branch: "b", slot: 1 };
    expect(await l.acquire(["slot"], 1, [ws], "/a")).toEqual(["slot:1"]);
    await l.bindSlot(1, 1, "/a");
    expect(await l.acquire(["slot"], 1, [ws], "/a")).toEqual(["slot:1"]);
    expect(await l.acquire(["slot"], 2, [ws], "/a")).toBeNull();
  });
  it("reclaims dead process+agent locks but retains live worktree reservations", async () => {
    const l = await locks();
    await atomic(l.file, {
      holders: [
        { resource: "db:shared", issue: 1, pid: 2147483646, since: "now" },
        { resource: "slot:2", issue: 1, pid: 2147483646, since: "now", workspace: "/keep" },
      ],
      waiters: [],
    });
    await l.reclaim([{ key: "x", path: "/keep", workspaceId: "w1", branch: "b", slot: 2 }], async () => false);
    expect((await l.list()).holders.map((h) => h.resource)).toEqual(["slot:2"]);
  });
  it("cross-process acquisitions contend on the same filesystem registry", async () => {
    const l = await locks();
    await l.acquire(["db:exclusive"], 1);
    const resultFile = path.join(l.dir, "child-result.json");
    const script = `import {Locks} from ${JSON.stringify(path.join(import.meta.dirname, "./.build/src/core/locks.mjs"))}; import {writeFile} from 'node:fs/promises'; const l=new Locks(${JSON.stringify(l.dir)},${JSON.stringify(l.config)}); await writeFile(${JSON.stringify(resultFile)},JSON.stringify(await l.acquire(['db:shared'],2)));`;
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script]);
    expect(JSON.parse(await fs.readFile(resultFile, "utf8"))).toBeNull();
  });
});

it("validates explicit NG auto choices and preserves shell parameter expressions", async () => {
  const source = await fs.readFile(path.join(import.meta.dirname, "../test/fixtures/WORKFLOW.md"), "utf8");
  expect(() => parseWorkflow(source.replace("ng_action: manual", "ng_action: auto"))).toThrow("choice");
  expect(render("${SHELL_VAR} {attempt}", { attempt: 2 })).toBe("${SHELL_VAR} 2");
});
it("restores a suspended shared lock after an aborted upgrade", async () => {
  const dir = await tmp();
  const w = await config();
  const l = new Locks(dir, w.locks);
  await l.acquire(["db:shared"], 1);
  await l.queue("db:exclusive", 1);
  await l.cancel("db:exclusive", 1);
  expect((await l.list()).holders.map((h) => h.resource)).toEqual(["db:shared"]);
  expect((await l.list()).waiters).toHaveLength(0);
});

it("accepts the minimal version 1 state schema from SPEC", async () => {
  const w = await config();
  const s = initialState(3740);
  s.step = "verify";
  s.status = "waiting_gate";
  s.gate = { name: "ng_action", since: s.updatedAt, summary: "NG", artifacts: [] } as never;
  delete (s as Partial<typeof s>).workspaces;
  delete (s as Partial<typeof s>).effects;
  delete (s as Partial<typeof s>).approvals;
  delete (s as Partial<typeof s>).completed;
  expect(checkState(s, 3740, w.steps).gate?.phase).toBe("ng");
  expect(s.effects).toEqual([]);
});
