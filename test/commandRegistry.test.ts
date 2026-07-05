// Unit tests for the command registry/dispatch/help tiering (spec/config/tui-ux-plan.md Phase 0/1).
// Run with: npx tsx test/commandRegistry.test.ts

import assert from "node:assert";
import { COMMAND_REGISTRY, type CommandContext } from "../src/tui/commands/registry.js";
import { dispatchCommand } from "../src/tui/commands/dispatch.js";
import { renderHelp } from "../src/tui/commands/help.js";

function makeCtx(overrides: Partial<CommandContext> = {}): {
  ctx: CommandContext;
  lines: string[];
} {
  const lines: string[] = [];
  const ctx: CommandContext = {
    client: {
      togglePlayPause: () => {},
      toggleReady: () => {},
      currentFileName: null,
      currentRoom: "lobby",
      changeRoom: () => {},
      addToPlaylist: () => {},
      selectPlaylistIndex: () => {},
      loadNextFileInPlaylist: () => {},
      removeFromPlaylist: () => {},
      undoPlaylist: () => {},
      requestControl: () => {},
      setUserOffset: () => {},
      userOffsetSeconds: 0,
      setOthersReadiness: () => {},
      seekTo: () => {},
      seekRelative: () => {},
      sendChat: () => {},
      selfUsername: "ata",
      isReady: true,
      autoPlayEnabled: false,
      userList: { all: () => [] },
      playlist: { files: [], index: null },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    host: "syncplay.pl",
    port: 8999,
    connectionStatus: "connected",
    room: "lobby",
    defaultRoom: "default",
    pushLine: (text: string) => lines.push(text),
    powerUserMode: false,
    setPowerUserMode: () => {},
    ...overrides,
  };
  return { ctx, lines };
}

// Every alias in the registry is unique across commands (no ambiguous dispatch).
{
  const seen = new Map<string, string>();
  for (const def of COMMAND_REGISTRY) {
    for (const alias of def.aliases) {
      assert.ok(
        !seen.has(alias),
        `alias "${alias}" claimed by both "${seen.get(alias)}" and "${def.name}"`,
      );
      seen.set(alias, def.name);
    }
  }
  console.log("commandRegistry.test.ts: PASS no duplicate aliases");
}

// Dispatch resolves an alias to its canonical command.
{
  let paused = false;
  const { ctx } = makeCtx({
    client: { ...makeCtx().ctx.client, togglePlayPause: () => (paused = true) },
  });
  dispatchCommand("p", ctx);
  assert.strictEqual(paused, true);
  console.log("commandRegistry.test.ts: PASS short alias dispatches to handler");
}

// Unknown commands report the error and print help.
{
  const { ctx, lines } = makeCtx();
  dispatchCommand("bogus", ctx);
  assert.ok(lines[0].includes("Unknown command: /bogus"));
  assert.ok(lines.some((l) => l.includes("Commands:")));
  console.log("commandRegistry.test.ts: PASS unknown command shows help");
}

// Basic help excludes power-tier commands; power-user help includes them.
{
  const basicHelp = renderHelp(false).join("\n");
  const powerHelp = renderHelp(true).join("\n");
  assert.ok(!basicHelp.includes("/setready"));
  assert.ok(powerHelp.includes("/setready"));
  assert.ok(powerHelp.includes("/toggle-power-user"));
  console.log("commandRegistry.test.ts: PASS tiered help filters power commands");
}

// /toggle-power-user flips the mode.
{
  let mode = false;
  const { ctx } = makeCtx({
    powerUserMode: false,
    setPowerUserMode: (v: boolean) => (mode = v),
  });
  dispatchCommand("toggle-power-user", ctx);
  assert.strictEqual(mode, true);
  console.log("commandRegistry.test.ts: PASS toggle-power-user flips mode");
}

console.log("commandRegistry.test.ts: ALL PASS");
