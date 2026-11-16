import type { Workflow, WorkspaceInfo } from "../types.js";
import { alive, atomic, exists, json, mutex } from "./files.js";
import { FlowPaths } from "./paths.js";

export type HeldLock = {
  resource: string;
  issue: number;
  pid: number;
  since: string;
  workspace?: string;
  suspendedShared?: boolean;
};
export type Waiter = {
  resource: string;
  issue: number;
  pid: number;
  since: string;
  suspendedShared?: boolean;
};
type Registry = { holders: HeldLock[]; waiters: Waiter[] };
export class Locks {
  readonly file: string;
  private shadow: Registry | null = null;
  constructor(
    readonly dir: string,
    readonly config: Workflow["locks"],
    readonly dryRun = false,
  ) {
    this.file = new FlowPaths(dir).lockRegistry;
  }
  async change<T>(fn: (r: Registry) => T | Promise<T>): Promise<T> {
    if (this.dryRun) {
      this.shadow ??= await this.readRegistry();
      return fn(this.shadow);
    }
    return mutex(
      new FlowPaths(this.dir).locksPid,
      async () => {
        const r = await this.readRegistry();
        const result = await fn(r);
        await atomic(this.file, r);
        return result;
      },
      true,
    );
  }
  private async readRegistry(): Promise<Registry> {
    const registry = await json<Registry>(this.file);
    if (registry === null && !(await exists(this.file))) return { holders: [], waiters: [] };
    if (
      !registry ||
      !Array.isArray(registry.holders) ||
      !Array.isArray(registry.waiters) ||
      !registry.holders.every(
        (h) =>
          typeof h.resource === "string" &&
          Number.isSafeInteger(h.issue) &&
          h.issue > 0 &&
          Number.isSafeInteger(h.pid) &&
          h.pid > 0,
      )
    )
      throw new Error("ロック台帳が壊れています。自動では初期化しません");
    return registry;
  }
  async list(): Promise<Registry> {
    return this.shadow ?? (await this.readRegistry());
  }
  validate(resource: string): void {
    if (/^slot:\d+$/.test(resource) && this.config.slots.includes(Number(resource.split(":")[1]))) return;
    const [name, mode] = resource.split(":");
    if (
      resource.split(":").length !== 2 ||
      !(name! in this.config.resources) ||
      !["shared", "exclusive"].includes(mode ?? "")
    )
      throw new Error(`未知の資源: ${resource}`);
  }
  async acquire(
    resources: string[],
    issue: number,
    occupied: WorkspaceInfo[] = [],
    workspace?: string,
  ): Promise<string[] | null> {
    return this.change((r) => {
      r.waiters = r.waiters.filter((w) => alive(w.pid));
      const selected: string[] = [];
      for (const requested of resources) {
        let resource = requested;
        if (requested === "slot") {
          const current = occupied.find((w) => w.path === workspace && w.slot !== null);
          const held = r.holders.find(
            (h) => h.issue === issue && h.workspace === workspace && h.resource.startsWith("slot:"),
          );
          const slot =
            current?.slot ??
            (held
              ? Number(held.resource.split(":")[1])
              : this.config.slots.find(
                  (n) => !occupied.some((w) => w.slot === n) && !r.holders.some((h) => h.resource === `slot:${n}`),
                ));
          if (slot == null) return null;
          resource = `slot:${slot}`;
        }
        this.validate(resource);
        const [name, mode] = resource.split(":");
        const conflicts = r.holders.some((h) => {
          if (h.resource.split(":")[0] !== name) return false;
          if (name === "slot")
            return h.resource === resource && (h.issue !== issue || (!!workspace && h.workspace !== workspace));
          return h.issue !== issue && (mode === "exclusive" || h.resource.endsWith(":exclusive"));
        });
        const external = name === "slot" && occupied.some((w) => w.slot === Number(mode) && w.path !== workspace);
        const writerWaiting =
          mode === "shared" &&
          !r.holders.some((h) => h.issue === issue && h.resource === resource) &&
          r.waiters.some((w) => w.resource === `${name}:exclusive` && w.issue !== issue);
        if (conflicts || external || writerWaiting) return null;
        selected.push(resource);
      }
      for (const resource of selected) {
        const name = resource.split(":")[0]!;
        const suspendedShared =
          resource.endsWith(":exclusive") &&
          (r.holders.some((h) => h.issue === issue && h.resource === `${name}:shared`) ||
            !!r.waiters.find((w) => w.issue === issue && w.resource === resource)?.suspendedShared);
        if (suspendedShared)
          r.holders = r.holders.filter((h) => !(h.issue === issue && h.resource === `${name}:shared`));
        if (!r.holders.some((h) => h.issue === issue && h.resource === resource))
          r.holders.push({
            resource,
            issue,
            pid: process.pid,
            since: new Date().toISOString(),
            workspace: resource.startsWith("slot:") ? workspace : undefined,
            suspendedShared,
          });
        r.waiters = r.waiters.filter((w) => !(w.issue === issue && w.resource === resource));
      }
      return selected;
    });
  }
  async bindSlot(issue: number, slot: number, workspace: string): Promise<void> {
    await this.change((r) => {
      const h = r.holders.find((h) => h.issue === issue && h.resource === `slot:${slot}`);
      if (h) h.workspace = workspace;
    });
  }
  /** A writer must retain read protection even when another writer is queued. */
  async downgrade(resource: string, issue: number): Promise<boolean> {
    this.validate(resource);
    if (!resource.endsWith(":exclusive")) throw new Error("exclusive ロックだけを shared に戻せます");
    return this.change((r) => {
      const shared = resource.replace(":exclusive", ":shared");
      const held = r.holders.find((h) => h.issue === issue && h.resource === resource);
      if (!held) return r.holders.some((h) => h.issue === issue && h.resource === shared);
      r.holders = r.holders.filter((h) => !(h.issue === issue && [resource, shared].includes(h.resource)));
      r.holders.push({ ...held, resource: shared, pid: process.pid, suspendedShared: false });
      r.waiters = r.waiters.filter((w) => !(w.issue === issue && w.resource === resource));
      return true;
    });
  }
  async queue(resource: string, issue: number): Promise<void> {
    this.validate(resource);
    await this.change((r) => {
      if (!r.waiters.some((w) => w.issue === issue && w.resource === resource))
        r.waiters.push({ resource, issue, pid: process.pid, since: new Date().toISOString() });
      // Upgrades release their own shared lock while waiting, allowing simultaneous upgrades to progress.
      if (resource.endsWith(":exclusive")) {
        const shared = r.holders.find(
          (h) => h.issue === issue && h.resource === resource.replace(":exclusive", ":shared"),
        );
        if (shared) {
          r.holders = r.holders.filter((h) => h !== shared);
          const waiter = r.waiters.find((w) => w.issue === issue && w.resource === resource);
          if (waiter) waiter.suspendedShared = true;
        }
      }
    });
  }
  async cancel(resource: string, issue: number): Promise<void> {
    // On an aborted upgrade, restore read protection before allowing the agent to resume.
    for (;;) {
      const restored = await this.change((r) => {
        const waiter = r.waiters.find((w) => w.issue === issue && w.resource === resource);
        if (waiter?.suspendedShared) {
          const shared = resource.replace(":exclusive", ":shared");
          if (r.holders.some((h) => h.issue !== issue && h.resource === resource)) return false;
          if (!r.holders.some((h) => h.issue === issue && h.resource === shared))
            r.holders.push({
              resource: shared,
              issue,
              pid: process.pid,
              since: new Date().toISOString(),
            });
        }
        r.waiters = r.waiters.filter((w) => !(w.issue === issue && w.resource === resource));
        return true;
      });
      if (restored) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  async release(issue: number, resource?: string, includeSlots = false): Promise<void> {
    await this.change((r) => {
      const removed = r.holders.filter(
        (h) =>
          h.issue === issue &&
          (resource ? h.resource === resource : includeSlots || !h.resource.startsWith("slot:") || !h.workspace),
      );
      r.holders = r.holders.filter((h) => !removed.includes(h));
      for (const h of removed)
        if (
          h.suspendedShared &&
          resource &&
          !r.holders.some(
            (other) => other.issue === issue && other.resource === h.resource.replace(":exclusive", ":shared"),
          )
        )
          r.holders.push({
            ...h,
            resource: h.resource.replace(":exclusive", ":shared"),
            suspendedShared: false,
          });
      if (!resource) r.waiters = r.waiters.filter((w) => w.issue !== issue);
    });
  }
  async reclaim(workspaces: WorkspaceInfo[], liveIssue: (issue: number) => Promise<boolean>): Promise<void> {
    await this.change(async (r) => {
      const keep: HeldLock[] = [];
      for (const h of r.holders) {
        if (
          h.resource.startsWith("slot:") &&
          workspaces.some((w) => w.path === h.workspace || w.slot === Number(h.resource.split(":")[1]))
        ) {
          keep.push(h);
          continue;
        }
        if (alive(h.pid) || (await liveIssue(h.issue))) keep.push(h);
      }
      r.holders = keep;
      r.waiters = r.waiters.filter((w) => alive(w.pid));
    });
  }
}
