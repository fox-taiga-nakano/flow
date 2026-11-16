import type { AgentResult, Gate, State, Workflow } from "./types.js";

export function gateKey(s: State, name: string, phase: Gate["phase"]): string {
  return `${s.step}:${phase === "before" ? 0 : s.attempt}:${phase}:${name}`;
}
export function approved(workflow: Workflow, s: State, name: string, phase: Gate["phase"]): boolean {
  return workflow.gates[name] === "auto" || s.approvals.includes(gateKey(s, name, phase));
}
export function makeGate(
  name: string,
  phase: Gate["phase"],
  summary: string,
  artifacts: string[] = [],
  now = new Date().toISOString(),
): Gate {
  return { name, phase, summary, artifacts, since: now };
}
export function resultGate(result: AgentResult): { name: string; phase: Gate["phase"] } | null {
  return result.result === "blocked" ? { name: "agent_question", phase: "question" } : null;
}
