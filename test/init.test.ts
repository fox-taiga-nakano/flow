import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vite-plus/test";

import { createProgram } from "../src/cli/commands.js";
import { parseRemote } from "../src/cli/init.js";
import type { CliServices } from "../src/cli/runtime.js";
import { FlowPaths } from "../src/core/paths.js";
import { parseWorkflow } from "../src/core/workflow.js";
import { temp } from "./helpers.js";

const root = path.resolve(import.meta.dirname, "..");
const git = (...args: string[]) => promisify(execFile)("git", args);

async function project(origin?: string) {
  const dir = await temp();
  await git("init", "-q", dir);
  if (origin) await git("-C", dir, "remote", "add", "origin", origin);
  const output = vi.fn();
  const services: CliServices = {
    paths: new FlowPaths(path.join(dir, ".flow")),
    open: vi.fn(async () => {
      throw new Error("init must not open the workflow");
    }),
    output,
    error: vi.fn(),
    sleep: vi.fn(async () => {}),
    now: vi.fn(() => 0),
  };
  const init = () => createProgram(services).parseAsync(["init"], { from: "user" });
  return { dir, output, init, text: () => output.mock.calls.map((c) => String(c[0])).join("\n") };
}

const skills = async () =>
  (await fs.readdir(path.join(root, "skills"), { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

describe("flow init", () => {
  it("lays out the workflow, the worktree config and every bundled skill", async () => {
    const p = await project("git@github.com:example-org/example-app.git");
    await p.init();

    const workflow = parseWorkflow(await fs.readFile(path.join(p.dir, ".flow/WORKFLOW.md"), "utf8"));
    expect(workflow.vars).toMatchObject({ main: p.dir, owner: "example-org", repo: "example-app" });
    expect(await fs.readFile(path.join(p.dir, ".herdr/worktree.json"), "utf8")).toBe(
      await fs.readFile(path.join(root, "templates/worktree.json"), "utf8"),
    );
    for (const name of await skills()) {
      expect(await fs.readFile(path.join(p.dir, ".agents/skills", name, "SKILL.md"), "utf8")).toBe(
        await fs.readFile(path.join(root, "skills", name, "SKILL.md"), "utf8"),
      );
      const link = path.join(p.dir, ".claude/skills", name);
      expect(await fs.readlink(link)).toBe(path.join("..", "..", ".agents", "skills", name));
      expect(await fs.readFile(path.join(link, "SKILL.md"), "utf8")).toContain(`name: ${name}`);
    }
    expect(p.text()).toContain("✔ 作成: .flow/WORKFLOW.md（vars: example-org/example-app）");
    expect(p.text()).toContain("次の作業:");
  });

  it("never overwrites what is already there", async () => {
    const p = await project("https://github.com/example-org/example-app");
    await fs.mkdir(path.join(p.dir, ".flow"));
    await fs.writeFile(path.join(p.dir, ".flow/WORKFLOW.md"), "mine");
    await fs.mkdir(path.join(p.dir, ".agents/skills/flow-repro"), { recursive: true });
    await fs.writeFile(path.join(p.dir, ".agents/skills/flow-repro/SKILL.md"), "mine");
    await p.init();

    expect(await fs.readFile(path.join(p.dir, ".flow/WORKFLOW.md"), "utf8")).toBe("mine");
    expect(await fs.readFile(path.join(p.dir, ".agents/skills/flow-repro/SKILL.md"), "utf8")).toBe("mine");
    expect(p.text()).toContain("! 既にあるので飛ばしました: .flow/WORKFLOW.md");
    expect(p.text()).toContain("! 既にあるので飛ばしました: .agents/skills/flow-repro");

    p.output.mockClear();
    await p.init();
    expect(p.text()).not.toContain("作成:");
  });

  it("leaves owner and repo to fill in when there is no origin", async () => {
    const p = await project();
    await p.init();
    const source = await fs.readFile(path.join(p.dir, ".flow/WORKFLOW.md"), "utf8");
    expect(source).toContain("REPLACE_WITH_GITHUB_OWNER");
    expect(parseWorkflow(source).vars.main).toBe(p.dir);
    expect(p.text()).toContain("owner・repo を読めませんでした");
  });

  it("reads owner and repo from https, scp-like and ssh remotes", () => {
    for (const url of [
      "https://github.com/o/r.git",
      "https://github.com/o/r",
      "git@github.com:o/r.git",
      "ssh://git@github.com/o/r.git\n",
    ])
      expect(parseRemote(url)).toEqual({ owner: "o", repo: "r" });
    expect(parseRemote("not a url")).toBeNull();
  });
});
