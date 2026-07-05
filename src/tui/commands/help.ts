// Tiered `/help` text generator. See ../../spec/config/tui-ux-plan.md Phase 1.

import { COMMAND_REGISTRY } from "./registry.js";

const NAV_LINES = [
  "Navigation:",
  "  Ctrl+←/→                switch panel (users · playlist · log)",
  "  ↑/↓ Enter               act in focused panel",
  "  //text                  literal chat starting with /",
];

export function renderHelp(powerUserMode: boolean): string[] {
  const basic = COMMAND_REGISTRY.filter((c) => c.tier === "basic");
  const lines = ["Commands:", ...basic.map((c) => `  ${c.usage}`), "", ...NAV_LINES];

  if (powerUserMode) {
    const power = COMMAND_REGISTRY.filter((c) => c.tier === "power");
    lines.push("", "Power-user commands:", ...power.map((c) => `  ${c.usage}`));
  } else {
    lines.push("", "Type /toggle-power-user to reveal advanced commands.");
  }

  return lines;
}
