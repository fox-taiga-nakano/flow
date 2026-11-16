import { promises as fs } from "node:fs";
import path from "node:path";

import { type Event, Events } from "./events.js";
import { alive, exists, mutex } from "./files.js";
import { FlowPaths, localDate } from "./paths.js";

type Move = { source: string; target: string };
export async function migrateLegacy(paths: FlowPaths): Promise<Move[]> {
  return mutex(
    paths.migrationPid,
    async () => {
      const moves: Move[] = [];
      for (const [name, target] of [
        ["owned.json", paths.owned],
        ["locks", paths.locksDirectory],
        ["issues.json", paths.issues],
        ["workflow-good.json", paths.workflowGood],
        ["virtual", path.dirname(paths.virtualIssue(1))],
        ["virtual-workspaces", path.dirname(paths.virtualWorkspace("x"))],
      ]) {
        const source = paths.legacy(name!);
        if (await exists(source)) moves.push({ source, target: target! });
      }
      for (const name of await fs.readdir(paths.run).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return [];
        throw e;
      })) {
        const match = /^assignment-preview-(\d+)\.json$/.exec(name);
        if (match) moves.push({ source: paths.legacy(name), target: paths.assignment(Number(match[1])) });
      }
      if (await exists(paths.legacy("locks/.mutex")))
        moves.unshift({ source: paths.legacy("locks/.mutex"), target: paths.locksPid });
      const oldLog = paths.legacy("events.ndjson");
      const logFiles = new Map<string, string[]>();
      if (await exists(oldLog)) {
        for (const line of (await fs.readFile(oldLog, "utf8")).split("\n").filter(Boolean)) {
          const event = JSON.parse(line) as Event;
          if (!event.at || !Number.isFinite(Date.parse(event.at)))
            throw new Error("旧 events.ndjson のイベント時刻が不正です");
          const target = paths.event(localDate(new Date(event.at)), event.dryRun === true);
          const lines = logFiles.get(target) ?? [];
          lines.push(line);
          logFiles.set(target, lines);
        }
      }
      // Validate every target before moving any source, including logs across dates.
      for (const target of [...moves.map((m) => m.target), ...logFiles.keys()])
        if (await exists(target)) throw new Error(`旧配置と新配置の両方にあります。移動しません: ${target}`);
      if (!moves.length && !(await exists(oldLog))) return [];
      for (const file of [paths.flowPid, paths.tickPid, paths.ownedPid, paths.legacy("locks/.mutex")]) {
        const pid = Number(
          await fs.readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
            if (e.code === "ENOENT") return "";
            throw e;
          }),
        );
        if (pid > 0 && alive(pid)) throw new Error(`flow の動作中は移行できません: ${file}`);
      }
      for (const move of moves) {
        await fs.mkdir(path.dirname(move.target), { recursive: true });
        await fs.rename(move.source, move.target);
      }
      for (const [target, lines] of logFiles) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, lines.join("\n") + "\n", { flag: "wx", mode: 0o600 });
        moves.push({ source: oldLog, target });
      }
      if (await exists(oldLog)) await fs.rm(oldLog);
      if (moves.length)
        await new Events(paths.root).add(
          0,
          null,
          "migration",
          moves.map((m) => `${m.source} -> ${m.target}`).join("\n"),
        );
      return moves;
    },
    true,
  );
}
