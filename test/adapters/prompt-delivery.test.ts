import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { HerdrRunner, type RawAgent } from "../../src/adapters/herdr.js";
import { promptView, terminalText } from "../../src/adapters/prompt-delivery.js";
import { Ownership } from "../../src/core/ownership.js";
import type { AgentHandle, ExecRequest } from "../../src/core/types.js";
import { config, harness, pr, temp } from "../helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function adapter(options: { dryRun?: boolean; waitMs?: number } = {}) {
  const dir = await temp();
  dirs.push(dir);
  const w = await config();
  const handle: AgentHandle = { runner: "herdr", name: "flow-repro-1", paneId: "w-test:p1", sessionId: "session-1" };
  const owned = new Ownership(dir, options.dryRun);
  await owned.addAgent(
    handle,
    { issue: 1, step: "repro" },
    { key: "main", path: dir, branch: "", workspaceId: null, slot: null },
  );
  let raw: RawAgent = {
    name: handle.name,
    pane_id: handle.paneId!,
    agent_session: { value: handle.sessionId },
    agent_status: "idle",
    interactive_ready: true,
  };
  let screen = "● 以前の回答\n❯ \n────────────────\n? for shortcuts";
  let revision = 0;
  const hooks = { prompt: async () => {}, enter: async () => {}, read: async () => {}, list: async () => {} };
  const exec = {
    run: vi.fn(async (r: ExecRequest) => {
      if (r.command === "herdr agent list") {
        await hooks.list();
        return JSON.stringify({ result: { agents: [raw] } });
      }
      if (r.command.startsWith("herdr agent read")) {
        await hooks.read();
        return JSON.stringify({
          id: String(++revision),
          result: { type: "pane_read", read: { text: screen, revision } },
        });
      }
      if (r.mutation && options.dryRun) return "";
      if (r.command.startsWith("herdr agent prompt")) await hooks.prompt();
      if (r.command.endsWith(" enter")) await hooks.enter();
      return "";
    }),
  };
  const runner = new HerdrRunner(exec, w.runner, dir, !!options.dryRun, owned, () => {}, {
    waitMs: options.waitMs ?? 0,
    pollMs: 1,
    settleMs: 0,
  });
  return {
    runner,
    handle,
    exec,
    hooks,
    owned,
    set: (change: Partial<RawAgent>, text?: string) => {
      raw = { ...raw, ...change };
      if (text !== undefined) screen = text;
    },
  };
}
const mutations = (h: Awaited<ReturnType<typeof adapter>>) =>
  h.exec.run.mock.calls.filter(([r]) => r.mutation).map(([r]) => r.command);

describe("prompt delivery evidence", () => {
  it("ignores envelope revisions and parses plain snapshots, rejecting malformed JSON envelopes", () => {
    expect(terminalText('{"result":{"read":{"text":"❯ hello"}}}')).toBe("❯ hello");
    expect(terminalText("plain")).toBe("plain");
    expect(() => terminalText('{"result":{}}')).toThrow("不正");
  });
  it("matches multiline wrapped input, excluding transcript matches and folded/truncated pastes", () => {
    expect(promptView("● previous\n❯ hello\n  world\n────────\n? for shortcuts", "hello\nworld").pending).toBe(true);
    expect(promptView("❯ hello world\n● response\n❯ \n────────", "hello world").pending).toBe(false);
    expect(promptView("❯ [Pasted text #1 +20 lines]\n────────", "hello world").pending).toBe(false);
    expect(promptView("❯ hello\n────────", "hello world").pending).toBe(false);
  });
  it("recognizes input surrounded by terminal color and hyperlink sequences", () => {
    const screen = "\x1b[32m❯ \x1b[0m\x1b]8;;https://example.test\x07hello\x1b]8;;\x07\n────────";
    expect(promptView(screen, "hello").pending).toBe(true);
  });
  it("does not count input echo or UI footer changes as response output", () => {
    const baseline = promptView("● previous\n❯ \n────────", "hello world");
    expect(promptView("● previous\n❯ hello world\n────────\n? changed", "hello world").output).toBe(baseline.output);
    expect(promptView("● previous\n❯ hello world\n❯ \n────────", "hello world").output).toBe(baseline.output);
  });
  it("confirms working after submission without sending Enter", async () => {
    const h = await adapter();
    h.hooks.prompt = async () => {
      h.set({ agent_status: "working" });
    };
    await h.runner.prompt(h.handle, "hello");
    expect(mutations(h)).toEqual(["herdr agent prompt 'flow-repro-1' 'hello'"]);
    expect(
      h.exec.run.mock.calls
        .filter(([r]) => r.command.startsWith("herdr agent read"))
        .every(([r]) => r.command.includes("--source visible")),
    ).toBe(true);
  });
  it("waits for delayed activity before acknowledging", async () => {
    const h = await adapter({ waitMs: 2000 });
    let reads = 0;
    h.hooks.prompt = async () => {
      h.hooks.read = async () => {
        if (++reads >= 2) h.set({ agent_status: "working" });
      };
    };
    await h.runner.prompt(h.handle, "hello");
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(mutations(h)).toHaveLength(1);
  });
  it("accepts new response output for a turn that finished between lifecycle samples", async () => {
    const h = await adapter();
    h.hooks.prompt = async () => {
      h.set({ agent_status: "done" }, "● 以前の回答\n❯ hello\n● 新しい回答\n❯ \n────────");
    };
    await h.runner.prompt(h.handle, "hello");
    expect(mutations(h)).toHaveLength(1);
  });
  it("sends exactly one Enter only when the complete prompt remains in input, then confirms working", async () => {
    const h = await adapter();
    h.hooks.prompt = async () => {
      h.set({}, "● 以前の回答\n❯ hello\n  world\n────────");
    };
    h.hooks.enter = async () => {
      h.set({ agent_status: "working" });
    };
    await h.runner.prompt(h.handle, "hello\nworld");
    expect(mutations(h)).toEqual([
      "herdr agent prompt 'flow-repro-1' 'hello\nworld'",
      "herdr agent send-keys 'flow-repro-1' enter",
    ]);
  });
  it("rejects after one ineffective Enter, never repeating the prompt or Enter", async () => {
    const h = await adapter();
    h.hooks.prompt = async () => {
      h.set({}, "● 以前の回答\n❯ hello\n────────");
    };
    await expect(h.runner.prompt(h.handle, "hello")).rejects.toThrow("Enter を1回");
    expect(mutations(h)).toHaveLength(2);
  });
  it.each(["empty", "transcript", "folded", "revision", "unknown"])(
    "does not send Enter based on %s evidence",
    async (mode) => {
      const h = await adapter();
      h.hooks.prompt = async () => {
        if (mode === "transcript") h.set({}, "● 以前の回答\n❯ hello\n❯ \n────────");
        if (mode === "folded") h.set({}, "● 以前の回答\n❯ [Pasted text #1 +20 lines]\n────────");
        if (mode === "unknown") h.set({ agent_status: "unknown" }, "❯ hello\n────────");
      };
      await expect(h.runner.prompt(h.handle, "hello")).rejects.toThrow("到達");
      expect(mutations(h)).toHaveLength(1);
    },
  );
  it.each(["blocked", "replaced", "missing"])("stops verification on %s without Enter", async (mode) => {
    const h = await adapter();
    h.hooks.prompt = async () => {
      h.set(
        mode === "blocked"
          ? { agent_status: "blocked" }
          : mode === "replaced"
            ? { agent_session: { value: "foreign" } }
            : { name: "other" },
        "❯ hello\n────────",
      );
    };
    await expect(h.runner.prompt(h.handle, "hello")).rejects.toThrow();
    expect(mutations(h)).toHaveLength(1);
  });
  it("does not send to a working agent or a foreign owner", async () => {
    const h = await adapter();
    h.set({ agent_status: "working" });
    await expect(h.runner.prompt(h.handle, "hello")).rejects.toThrow("idle / done");
    await expect(h.runner.prompt({ ...h.handle, name: "human" }, "hello")).rejects.toThrow("所有記録");
    expect(mutations(h)).toHaveLength(0);
  });
  it("dry-run plans submission without waiting for skipped activity or sending Enter", async () => {
    const h = await adapter({ dryRun: true });
    await h.runner.prompt(h.handle, "hello");
    expect(mutations(h)).toHaveLength(1);
    expect(h.exec.run.mock.calls.some(([r]) => r.command.startsWith("herdr agent read"))).toBe(false);
  });
  it("rechecks readiness after settling and does not send through a new startup dialog", async () => {
    const h = await adapter();
    let calls = 0;
    h.hooks.list = async () => {
      if (++calls === 2) h.set({ agent_status: "blocked" });
    };
    expect(await h.runner.ready(h.handle)).toBe("blocked");
    expect(mutations(h)).toHaveLength(0);
  });
  it("does not send Enter if the pasted input disappeared before the final inspection", async () => {
    const h = await adapter();
    let reads = 0;
    h.hooks.prompt = async () => {
      h.set({}, "● 以前の回答\n❯ hello\n────────");
      h.hooks.read = async () => {
        if (++reads >= 2) h.set({}, "● 以前の回答\n❯ \n────────");
      };
    };
    await expect(h.runner.prompt(h.handle, "hello")).rejects.toThrow("入力欄");
    expect(mutations(h)).toHaveLength(1);
  });
  it("reads visible text while working without scrolling recent application history", async () => {
    const h = await adapter();
    h.set({ agent_status: "working" });
    expect(await h.runner.tail(h.handle, 80)).toContain("以前の回答");
    expect(h.exec.run.mock.calls.at(-1)?.[0].command).toContain("--source visible --lines 80");
    h.set({ agent_status: "done" });
    await h.runner.tail(h.handle, 80);
    expect(h.exec.run.mock.calls.at(-1)?.[0].command).toContain("--source recent-unwrapped");
  });
});

async function core(stage?: string) {
  const h = await harness({ stage });
  dirs.push(h.dir);
  return h;
}
describe("durable prompt receipts", () => {
  it("does not record an initial receipt until delivery resolves", async () => {
    const h = await core();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(h.a.runner.prompt).mockImplementation(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const tick = h.o.tick();
    await started;
    const pending = (await h.o.states.read(1))!;
    expect(pending.inflight?.key).toBe("repro:1:initial-prompt");
    expect(pending.effects).not.toContain("repro:1:initial-prompt");
    release();
    await tick;
    expect((await h.o.states.read(1))?.effects).toContain("repro:1:initial-prompt");
  });
  it("keeps an uncertain initial delivery gated across process restarts without auto resend", async () => {
    const h = await core();
    vi.mocked(h.a.runner.prompt).mockRejectedValueOnce(new Error("Enter failed"));
    await h.o.tick();
    await h.make().tick();
    await h.make().tick();
    const state = (await h.o.states.read(1))!;
    expect(state.gate?.name).toBe("operation_recovery");
    expect(state.effects).not.toContain("repro:1:initial-prompt");
    expect(h.a.runner.prompt).toHaveBeenCalledTimes(1);
  });
  it.each(["applied", "retry"])("recovers uncertain result reminders via explicit %s only", async (choice) => {
    const h = await core();
    await h.o.tick();
    vi.mocked(h.a.runner.status).mockResolvedValue("done");
    vi.mocked(h.a.runner.prompt).mockRejectedValueOnce(new Error("delivery unknown"));
    await h.o.tick();
    let state = (await h.o.states.read(1))!;
    expect(state.gate?.name).toBe("operation_recovery");
    expect(state.inflight?.key).toBe("repro:1:result-reminder");
    expect(state.effects).not.toContain("repro:1:result-reminder");
    expect(state.resultReminder).toBe(false);
    await h.make().tick();
    expect(h.a.runner.prompt).toHaveBeenCalledTimes(2);
    await h.make().control(1, "approve", { choice });
    // Keep applied delivery working; retry must execute exactly one reminder.
    if (choice === "applied") vi.mocked(h.a.runner.status).mockResolvedValue("working");
    await h.make().tick();
    state = (await h.o.states.read(1))!;
    expect(state.resultReminder).toBe(true);
    expect(state.effects).toContain("repro:1:result-reminder");
    expect(h.a.runner.prompt).toHaveBeenCalledTimes(choice === "applied" ? 2 : 3);
  });
  it("gates an uncertain on_approve prompt immediately, with no receipt or automatic resubmission", async () => {
    const h = await core("検証済");
    h.prs.set(1, [pr()]);
    await h.o.tick();
    await h.o.control(1, "approve", { gate: "finish_start" });
    await h.o.tick();
    await h.file(1, "pr-body.md");
    await h.result(1);
    vi.mocked(h.a.runner.status).mockResolvedValue("done");
    await h.o.tick();
    vi.mocked(h.a.runner.prompt).mockRejectedValueOnce(new Error("not acknowledged"));
    await expect(h.o.control(1, "approve")).rejects.toThrow("not acknowledged");
    const state = (await h.o.states.read(1))!;
    expect(state.gate?.name).toBe("operation_recovery");
    expect(state.inflight?.key).toBe("finish:1:continue");
    expect(state.effects).not.toContain("finish:1:continue");
    await h.make().tick();
    expect(h.a.runner.prompt).toHaveBeenCalledTimes(2);
  });
});
