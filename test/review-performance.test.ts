import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vite-plus/test";

import { DirsStageStore } from "../src/adapters/dirs.js";
import { harness } from "./helpers.js";

it("measures unchanged waiting Issue directory commands", async () => {
  const h = await harness();
  const dir = path.join(h.dir, "issues/1-未着手_1");
  await fs.mkdir(dir, { recursive: true });
  const exec = { run: vi.fn(async () => dir) };
  h.a.stages = new DirsStageStore(exec, h.workflow.stage_store, h.workflow.vars);
  h.workflow.gates.start = "manual";
  const o = h.make();
  await o.tick();
  exec.run.mockClear();
  await o.tick();
  const calls = exec.run.mock.calls.length;
  expect(calls).toBe(1);
  await fs.rm(h.dir, { recursive: true, force: true });
});
