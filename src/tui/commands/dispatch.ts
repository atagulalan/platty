// Parses a slash command (without the leading "/") and runs it against the registry.
// See ../../../../spec/config/tui-ux-plan.md Phase 0.

import { COMMAND_REGISTRY, type CommandContext } from "./registry.js";
import { renderHelp } from "./help.js";

export function dispatchCommand(raw: string, ctx: CommandContext): void {
  const [cmdRaw, ...rest] = raw.split(" ");
  const cmd = (cmdRaw ?? "").toLowerCase();
  const arg = rest.join(" ");
  const def = COMMAND_REGISTRY.find((d) => d.aliases.includes(cmd));
  if (!def) {
    ctx.pushLine(`Unknown command: /${cmdRaw}`, "error");
    renderHelp(ctx.powerUserMode).forEach((line) => ctx.pushLine(line));
    return;
  }
  def.handler(ctx, arg);
}
