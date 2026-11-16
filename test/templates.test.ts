import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";

import { parseWorkflow } from "../src/core/workflow.js";

it("ships a valid workflow template that fails closed until commands are configured", () => {
  const source = readFileSync(new URL("../templates/WORKFLOW.md", import.meta.url), "utf8");
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
