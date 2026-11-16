import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vite-plus/test";

import { parseWorkflow } from "../../src/core/workflow.js";

it("ships a valid workflow template that fails closed until commands are configured", () => {
  const source = readFileSync(new URL("../../templates/WORKFLOW.md", import.meta.url), "utf8");
  const workflow = parseWorkflow(source);
  const commands = [
    ...Object.values(workflow.stage_store.commands),
    ...Object.values(workflow.workspace.commands),
    workflow.base.resolve,
  ];
  for (const command of commands) {
    expect(command).toBeDefined();
    expect(() => execFileSync("/bin/bash", ["-c", command!], { stdio: "pipe" })).toThrow();
  }
});

it("bundles every skill that the workflow template's prompts follow, named after its directory", () => {
  const source = readFileSync(new URL("../../templates/WORKFLOW.md", import.meta.url), "utf8");
  const workflow = parseWorkflow(source);
  const skills = new URL("../../skills/", import.meta.url);
  const referenced = [...source.matchAll(/\.claude\/skills\/([\w-]+)\/SKILL\.md/g)].map((m) => m[1]!);
  expect(new Set(referenced)).toEqual(new Set(["flow-repro", "flow-refine", "flow-verify", "flow-finish"]));
  for (const step of ["repro", "refine", "verify", "finish"])
    expect(workflow.prompts[step]).toContain(`.claude/skills/flow-${step}/SKILL.md`);
  for (const name of readdirSync(skills)) {
    const skill = readFileSync(new URL(`${name}/SKILL.md`, skills), "utf8");
    expect(skill).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: \\S`));
  }
});
