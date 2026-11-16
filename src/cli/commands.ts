import { Command, InvalidArgumentError, Option } from "commander";
import { promises as fs } from "node:fs";

import { mutex } from "../core/files.js";
import type { StatusRow } from "../core/orchestrator.js";
import { checkDate } from "../core/paths.js";
import { orderStages } from "../core/stage-order.js";
import { readCursor, scan, writeCursor } from "../core/watch.js";
import { issueLink } from "../core/workflow.js";
import { Output } from "../output.js";
import { localize, notes, summaries } from "./help.js";
import { type RunModel, changedFields, runFrame } from "./run-frame.js";
import { type CliServices, issueLocations, showStatus, table } from "./runtime.js";
import { registerTools, runTool } from "./tools.js";

function positiveInteger(raw: string): number {
  const value = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value))
    throw new InvalidArgumentError("正の整数を指定してください");
  return value;
}
function days(raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new InvalidArgumentError("days は正の整数です");
  return value;
}
function interval(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new InvalidArgumentError("interval は正の秒数です");
  return value;
}
function timeout(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new InvalidArgumentError("timeout は0以上のミリ秒です");
  return value;
}
function seconds(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new InvalidArgumentError("正の秒数を指定してください");
  return value;
}
function date(raw: string): string {
  try {
    return checkDate(raw);
  } catch {
    throw new InvalidArgumentError("日付は実在する YYYY-MM-DD で指定してください");
  }
}

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );
/** Leaves a wake file for a running `flow run`, so it ticks now instead of after its interval. */
async function wakeRun(paths: { flowPid: string; wake: string }): Promise<void> {
  if (await exists(paths.flowPid)) await fs.writeFile(paths.wake, "");
}

export function createProgram(services: CliServices): Command {
  const view = services.view ?? new Output({ isTTY: false });
  const program = localize(new Command("flow"), services)
    .description("Issue の各段階を進めるオーケストレーター")
    .option("--project <path>", "対象プロジェクト（既定: カレントディレクトリ）")
    .helpCommand("help [command]", "コマンドの使い方を表示")
    .allowExcessArguments(false)
    .enablePositionalOptions();
  const command = (name: string, isDefault = false) =>
    localize(program.command(name, { isDefault }), services)
      .description(summaries[name]!)
      .allowExcessArguments(false)
      .addHelpText("after", `\n${notes[name]}`);

  command("tick")
    .option("--dry-run", "変更せず実行予定を表示", false)
    .action(async (options: { dryRun: boolean }) => {
      const o = await services.open(options.dryRun);
      table(
        await o.tick(),
        services.output,
        view,
        o.workflow.stage_store.rejected,
        o.workflow.stage_store.order,
        issueLink(o.workflow),
      );
      if (options.dryRun)
        services.output(
          view.prose("dry-run: 状態を変える外部コマンドはすべて SKIPPED。state.json・ロック・段階は未変更。", "muted"),
        );
    });
  command("run")
    .option("--interval <秒>", "tick の実行間隔", interval, 60)
    .option("--dry-run", "変更せず実行予定を表示", false)
    .action(async (options: { interval: number; dryRun: boolean }) => {
      const o = await services.open(options.dryRun);
      let stopped = services.outputSignal?.aborted ?? false;
      let wake: (() => void) | undefined;
      const stop = () => {
        stopped = true;
        wake?.();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      services.outputSignal?.addEventListener("abort", stop, { once: true });
      try {
        await mutex(services.paths.flowPid, async () => {
          const live = services.live;
          const model: RunModel = {
            rows: [],
            notices: [],
            changed: new Map(),
            ticking: false,
            stopped: false,
            interval: options.interval,
          };
          const draw = () => live?.render(runFrame(model, view, services.now()));
          const stopResize = live?.onResize(() => {
            live.invalidate();
            draw();
          });
          let seen: StatusRow[] | undefined;
          try {
            while (!stopped) {
              wake = undefined;
              // A wake request made before this tick starts is served by it.
              await fs.rm(services.paths.wake, { force: true });
              // The previous frame stays on screen while the tick runs; only its last line changes.
              model.ticking = true;
              model.next = undefined;
              draw();
              const notices: string[] = [];
              const release = live?.capture((text) => notices.push(text));
              try {
                const current = await services.open(options.dryRun);
                const rows = orderStages(await current.tick(), current.workflow.stage_store.order);
                const link = issueLink(current.workflow);
                if (live) {
                  Object.assign(model, {
                    rows,
                    link,
                    rejected: current.workflow.stage_store.rejected,
                    timezone: current.workflow.timezone,
                    changed: changedFields(seen, rows),
                    at: services.now(),
                  });
                  seen = rows;
                } else
                  table(
                    rows,
                    services.output,
                    view,
                    current.workflow.stage_store.rejected,
                    current.workflow.stage_store.order,
                    link,
                  );
              } catch (error) {
                if (live) notices.push(view.tone(String(error), "error"));
                else services.error(view.tone(String(error), "error"));
                await o.events.add(0, null, "tick_error", String(error));
              } finally {
                release?.();
              }
              model.notices = notices;
              model.ticking = false;
              if (stopped) break;
              if (await exists(services.paths.wake)) continue;
              model.next = services.now() + options.interval * 1000;
              draw();
              await new Promise<void>((resolve) => {
                // Only the countdown line differs from second to second, so each redraw writes one line.
                const countdown = live ? setInterval(draw, 1000) : undefined;
                // `flow approve` and the like leave the wake file to skip the rest of the wait.
                const poll = setInterval(() => void exists(services.paths.wake).then((w) => w && finish()), 1000);
                const finish = () => {
                  clearTimeout(timer);
                  clearInterval(countdown);
                  clearInterval(poll);
                  resolve();
                };
                const timer = setTimeout(finish, options.interval * 1000);
                wake = finish;
              });
            }
          } finally {
            model.ticking = false;
            model.stopped = true;
            draw();
            stopResize?.();
            live?.close();
          }
        });
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        services.outputSignal?.removeEventListener("abort", stop);
      }
    });
  const status = command("status", true)
    .argument("[issue]", "正の Issue 番号（省略で一覧）", positiveInteger)
    .option("--json", "JSON で表示", false)
    .action(async (issue: number | undefined, options: { json: boolean }) => {
      const o = await services.open(false, true, false);
      await showStatus(o, services.paths, issue, options.json, services.output, view);
    });
  program.hook("preSubcommand", (parent, child) => {
    const first = parent.args[0];
    if (child === status && first && first !== status.name() && !/^\d+$/.test(first) && !first.startsWith("-")) {
      // Commander 15's native unknownCommand includes suggestions and uses the parent's help.
      // The runtime method is not included in Command's public TypeScript declarations.
      (parent as Command & { unknownCommand(): never }).unknownCommand();
    }
  });
  program.showSuggestionAfterError(true);

  command("approve")
    .argument("<issue>", "正の Issue 番号", positiveInteger)
    .argument("[gate]", "現在の gate（省略可）")
    .addOption(
      new Option(
        "--choice <選択>",
        "ng_action / base_changed / 復旧 / 開始 gate の skip / cleanup の keep の選択",
      ).choices(["copilot", "self", "stop", "keep", "retarget", "applied", "retry", "skip"]),
    )
    .action(async (issue: number, gate: string | undefined, options: { choice?: string }) => {
      const o = await services.open(false);
      await o.control(issue, "approve", { gate, choice: options.choice });
      await wakeRun(services.paths);
      services.output(
        view.result(
          `#${issue} の${gate ? ` gate ${gate} を` : " gate を"}承認しました${options.choice ? `（選択: ${options.choice}）` : ""}`,
        ),
      );
    });
  command("reject")
    .argument("<issue>", "正の Issue 番号", positiveInteger)
    .argument("[gate]", "現在の gate（省略可）")
    .option("--reason <理由>", "履歴に残す却下理由")
    .action(async (issue: number, gate: string | undefined, options: { reason?: string }) => {
      const o = await services.open(false);
      await o.control(issue, "reject", { gate, reason: options.reason });
      await wakeRun(services.paths);
      services.output(
        view.result(`#${issue} を対象外にしました${options.reason ? `（理由: ${options.reason}）` : ""}`, "inactive"),
      );
    });
  command("retry")
    .argument("<issue>", "正の Issue 番号", positiveInteger)
    .action(async (issue: number) => {
      const o = await services.open(false);
      await o.control(issue, "retry");
      await wakeRun(services.paths);
      services.output(view.result(`#${issue} の試行回数を戻し、再開待ちにしました`));
    });
  command("stop")
    .argument("<issue>", "正の Issue 番号", positiveInteger)
    .option("--reason <理由>", "停止の理由")
    .action(async (issue: number, options: { reason?: string }) => {
      const o = await services.open(false);
      await o.control(issue, "stop", { reason: options.reason });
      await wakeRun(services.paths);
      services.output(
        view.result(`#${issue} を停止しました${options.reason ? `（理由: ${options.reason}）` : ""}`, "inactive"),
      );
    });

  command("answer")
    .argument("<issue>", "正の Issue 番号", positiveInteger)
    .argument("<text>", "質問への回答")
    .action(async (issue: number, text: string) => {
      const o = await services.open(false);
      await o.answer(issue, text);
      await wakeRun(services.paths);
      services.output(view.result(`#${issue} の agent に回答を送りました`));
    });
  command("open")
    .argument("<issue>", "正の Issue 番号", positiveInteger)
    .action(async (issue: number) => {
      const o = await services.open(false);
      await o.open(issue);
      services.output(view.result(`#${issue} のタブを開きました`));
    });

  command("watch")
    .option("--prime", "既存のログを読まず、今の末尾から監視を始める", false)
    .option("--timeout <秒>", "イベントが無いときに待つ上限", seconds, 600)
    .option("--interval <秒>", "ログを読み直す間隔", seconds, 1)
    .action(async (options: { prime: boolean; timeout: number; interval: number }) => {
      const paths = services.paths;
      try {
        await mutex(`${paths.watchCursor}.pid`, async () => {
          const saved = await readCursor(paths.watchCursor);
          if (options.prime || !saved) {
            await writeCursor(paths.watchCursor, (await scan(paths.logs, saved ?? {}, true)).cursor);
            services.output(JSON.stringify({ initialized: true, events: [] }));
            return;
          }
          const deadline = services.now() + options.timeout * 1000;
          let cursor = saved;
          for (;;) {
            const found = await scan(paths.logs, cursor);
            cursor = found.cursor;
            if (found.events.length || services.now() >= deadline) {
              await writeCursor(paths.watchCursor, cursor);
              services.output(JSON.stringify({ initialized: false, events: found.events }));
              return;
            }
            await services.sleep(Math.min(options.interval * 1000, Math.max(0, deadline - services.now())));
          }
        });
      } catch (e) {
        if (String(e).includes("別プロセスが実行中")) throw new Error("別の flow watch が動いています");
        throw e;
      }
    });
  registerTools(
    program,
    (parent, name) =>
      parent === program ? command(name) : localize(parent.command(name), services).allowExcessArguments(false),
    services.runTool ?? runTool,
    (code) => {
      process.exitCode = code;
    },
  );

  const lock = command("lock").helpCommand("help [command]", "コマンドの使い方を表示");
  lock.action(() => lock.error("引数が足りません: <acquire|release|list>", { code: "commander.missingArgument" }));
  const lockCommand = (name: string, description: string) =>
    localize(lock.command(name), services)
      .description(description)
      .allowExcessArguments(false)
      .addHelpText("after", `\n${notes[`lock ${name}`]}`);
  lockCommand("acquire", "資源ロックを取得")
    .argument("<resource>", "db:shared / db:exclusive など")
    .requiredOption("--issue <番号>", "ロックを持つ Issue 番号", positiveInteger)
    .option("--wait", "取得できるまで待つ", false)
    .option("--timeout <ms>", "待つ上限ミリ秒（0は無制限）", timeout, 0)
    .action(async (resource: string, options: { issue: number; wait: boolean; timeout: number }) => {
      const o = await services.open(false);
      o.locks.validate(resource);
      const started = services.now();
      if (options.wait) await o.locks.queue(resource, options.issue);
      try {
        for (;;) {
          if (await o.acquireResource(resource, options.issue)) {
            services.output(view.result(`#${options.issue} のロック ${resource} を取得しました`));
            return;
          }
          if (!options.wait || (options.timeout > 0 && services.now() - started >= options.timeout))
            throw new Error(`lock を取得できません: ${resource}`);
          await services.sleep(200);
        }
      } finally {
        await o.locks.cancel(resource, options.issue);
      }
    });
  lockCommand("release", "資源ロックを解放")
    .argument("<resource>", "解放する資源名")
    .requiredOption("--issue <番号>", "ロックを持つ Issue 番号", positiveInteger)
    .action(async (resource: string, options: { issue: number }) => {
      const o = await services.open(false);
      o.locks.validate(resource);
      await o.releaseResource(resource, options.issue);
      services.output(view.result(`#${options.issue} のロック ${resource} を解放しました`));
    });
  lockCommand("list", "ロックの一覧を表示").action(async () => {
    const o = await services.open(false);
    services.output(view.locks(await o.locks.list(), o.workflow.timezone));
  });
  command("logs")
    .argument("[issue]", "正の Issue 番号（省略で全体）", positiveInteger)
    .option("-f, --follow", "ログを追跡", false)
    .addOption(new Option("--date <YYYY-MM-DD>", "日本時間の指定日").argParser(date).conflicts("days"))
    .addOption(new Option("--days <N>", "今日を含む過去N日").argParser(days).default(1))
    .action(async (issue: number | undefined, options: { follow: boolean; date?: string; days: number }) => {
      const o = await services.open(false);
      const seen = new Map<string, number>();
      let first = true;
      do {
        const counts = new Map<string, number>();
        const rows = await o.events.read(issue, options.date ? { date: options.date } : { days: options.days });
        const fresh = [];
        for (const e of rows) {
          const key = JSON.stringify(e);
          const count = (counts.get(key) ?? 0) + 1;
          counts.set(key, count);
          if (count > (seen.get(key) ?? 0)) fresh.push(e);
        }
        if (fresh.length || first)
          services.output(
            view.logs(
              fresh,
              o.workflow.timezone,
              await issueLocations(
                o,
                fresh.map((e) => e.issue),
              ),
            ),
          );
        first = false;
        for (const [key, count] of counts) seen.set(key, Math.max(seen.get(key) ?? 0, count));
        if (options.follow) await services.sleep(500);
      } while (options.follow && !services.outputSignal?.aborted);
    });
  command("validate").action(async () => {
    await services.open(false, false, false);
    services.output(view.result("WORKFLOW.md: valid"));
  });

  // Keep options before the command using Commander's option definitions and hooks.
  // Values stay in Commander, with their parsed types and source; actions receive native opts().
  program.option("--json", "状態を JSON で表示（コマンド省略時は status）");
  const descendants = (cmd: Command): Command[] => cmd.commands.flatMap((child) => [child, ...descendants(child)]);
  for (const child of descendants(program))
    for (const option of child.options) {
      if (program.options.some((existing) => existing.attributeName() === option.attributeName())) continue;
      const global = new Option(option.flags, option.description).hideHelp();
      if (option.parseArg) global.argParser(option.parseArg);
      if (option.argChoices) global.choices(option.argChoices);
      program.addOption(global);
    }
  for (const parent of [program, lock])
    parent.hook("preSubcommand", (_parent, child) => {
      for (const option of child.options) {
        const key = option.attributeName();
        if (program.getOptionValueSource(key) === "cli")
          child.setOptionValueWithSource(key, program.getOptionValue(key), "cli");
      }
    });
  program.hook("preAction", (_root, action) => {
    for (const option of program.options)
      if (
        option.attributeName() !== "project" &&
        program.getOptionValueSource(option.attributeName()) === "cli" &&
        !action.options.some((local) => local.attributeName() === option.attributeName())
      )
        action.error(`使えないオプションです: ${option.long ?? option.short}`, { code: "commander.unknownOption" });
  });
  return program;
}
