import { Output } from "../cli/output.js";
import { render } from "../core/template.js";
import type { Exec, Notifier, Workflow } from "../core/types.js";
import { issueLink } from "../core/workflow.js";

export class CommandNotifier implements Notifier {
  constructor(
    readonly exec: Exec,
    readonly workflow: Workflow,
    readonly output = console.log,
    readonly view = new Output(),
  ) {}
  async notify(msg: Parameters<Notifier["notify"]>[0]): Promise<void> {
    this.output(this.view.notification(msg, issueLink(this.workflow)));
    if (this.workflow.notifier.command)
      await this.exec.run({
        command: render(
          this.workflow.notifier.command,
          { ...this.workflow.vars, ...msg, sound: msg.level === "info" ? "none" : "request" },
          true,
        ),
        cwd: String(this.workflow.vars.main),
        mutation: true,
      });
  }
}
