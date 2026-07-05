// Command registry — single source of truth for dispatch, help, and autocomplete.
// See ../../../../spec/config/tui-ux-plan.md Phase 0 and source/syncplay/constants.py's
// COMMANDS_* alias lists (the canonical parity reference).

import type { SyncplayClient } from "../../client/SyncplayClient.js";
import type { LogLine } from "../components/LogPanel.js";
import type { ConnectionStatus } from "../components/StatusBar.js";
import { renderHelp } from "./help.js";

export type CommandTier = "basic" | "power";

export interface CommandContext {
  client: SyncplayClient;
  host: string;
  port: number;
  connectionStatus: ConnectionStatus;
  /** Current room, used by /auth as the room to request control of. */
  room: string;
  /** Config's configured room, used as the /room command's last-resort fallback. */
  defaultRoom?: string;
  pushLine: (text: string, kind?: LogLine["kind"]) => void;
  onSetup?: () => void;
  onSettings?: () => void;
  onSet?: (key: string, value: string) => string;
  onExit?: () => void;
  powerUserMode: boolean;
  setPowerUserMode: (value: boolean) => void;
}

export interface CommandDef {
  /** Canonical long name (no leading slash). */
  name: string;
  /** All accepted forms, including `name`, matched case-insensitively. */
  aliases: string[];
  tier: CommandTier;
  /** Pre-formatted `/help` line, e.g. "/pause, /p              pause/play". */
  usage: string;
  handler: (ctx: CommandContext, arg: string) => void;
}

function parsePlaylistIndex(arg: string, count: number): number | null {
  const trimmed = arg.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n)) return null;
  const index = n - 1;
  if (index < 0 || index >= count) return null;
  return index;
}

function parseSignedOrAbsolute(arg: string): { relative: boolean; value: number } | null {
  const trimmed = arg.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("+") || trimmed.startsWith("-")) {
    const magnitude = Number(trimmed.slice(1));
    if (!Number.isFinite(magnitude)) return null;
    return { relative: true, value: trimmed.startsWith("-") ? -magnitude : magnitude };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return { relative: false, value };
}

function listUsers(ctx: CommandContext): void {
  const all = ctx.client.userList.all();
  if (all.length === 0) {
    ctx.pushLine("No users known.");
    return;
  }
  const byRoom = new Map<string, typeof all>();
  for (const u of all) {
    const list = byRoom.get(u.room) ?? [];
    list.push(u);
    byRoom.set(u.room, list);
  }
  for (const [roomName, roomUsers] of byRoom) {
    ctx.pushLine(`In room "${roomName}"${roomName === ctx.client.currentRoom ? " (current)" : ""}:`);
    for (const u of roomUsers) {
      const flags = [u.controller ? "controller" : null, u.ready ? "ready" : null].filter(Boolean).join(", ");
      const marker = u.username === ctx.client.selfUsername ? "*" : " ";
      const fileInfo = u.file ? ` — ${u.file.name}` : "";
      ctx.pushLine(`  ${marker}${u.username}${flags ? ` (${flags})` : ""}${fileInfo}`);
    }
  }
}

function showPlaylist(ctx: CommandContext): void {
  const { files, index } = ctx.client.playlist;
  if (files.length === 0) {
    ctx.pushLine("Playlist is empty.");
    return;
  }
  files.forEach((f, i) => {
    ctx.pushLine(`${i === index ? " *" : "  "}${i + 1}: ${f}`);
  });
}

function showStatus(ctx: CommandContext): void {
  const ready = ctx.client.isReady;
  ctx.pushLine(`Server: ${ctx.host}:${ctx.port}`);
  ctx.pushLine(`Connection: ${ctx.connectionStatus}`);
  ctx.pushLine(`User: ${ctx.client.selfUsername}`);
  ctx.pushLine(`Room: ${ctx.client.currentRoom}`);
  ctx.pushLine(`Ready: ${ready === null ? "unknown" : ready ? "yes" : "no"}`);
  ctx.pushLine(`Autoplay: ${ctx.client.autoPlayEnabled ? "on" : "off"}`);
  const file = ctx.client.currentFileName;
  if (file) ctx.pushLine(`File: ${file}`);
}

export const COMMAND_REGISTRY: CommandDef[] = [
  // --- basic tier ---
  {
    name: "pause",
    aliases: ["pause", "p", "play"],
    tier: "basic",
    usage: "/pause, /p              pause/play",
    handler: (ctx) => ctx.client.togglePlayPause(),
  },
  {
    name: "toggle",
    aliases: ["toggle", "t"],
    tier: "basic",
    usage: "/toggle, /t             toggle ready",
    handler: (ctx) => ctx.client.toggleReady(),
  },
  {
    name: "autoplay",
    aliases: ["autoplay", "ap"],
    tier: "basic",
    usage: "/autoplay, /ap [on|off] toggle autoplay when everyone is ready",
    handler: (ctx, arg) => {
      const trimmed = arg.trim().toLowerCase();
      if (trimmed === "on" || trimmed === "true" || trimmed === "1") {
        ctx.client.changeAutoplayState(true);
      } else if (trimmed === "off" || trimmed === "false" || trimmed === "0") {
        ctx.client.changeAutoplayState(false);
      } else {
        ctx.client.changeAutoplayState(!ctx.client.autoPlayEnabled);
      }
      ctx.pushLine(`Autoplay ${ctx.client.autoPlayEnabled ? "enabled" : "disabled"}.`);
    },
  },
  {
    name: "room",
    aliases: ["room", "r"],
    tier: "basic",
    usage: "/room, /r [room]        change room",
    handler: (ctx, arg) => {
      // No argument: fall back to the current file's name, then the configured default room —
      // mirrors source/syncplay/ui/consoleUI.py's COMMANDS_ROOM handling (~line 171-179).
      const target = arg || ctx.client.currentFileName || ctx.defaultRoom;
      if (target) ctx.client.changeRoom(target);
    },
  },
  {
    name: "add",
    aliases: ["add", "qa", "queue"],
    tier: "basic",
    usage: "/add, /qa <file>        add to playlist",
    handler: (ctx, arg) => {
      if (!arg) {
        ctx.pushLine("Usage: /add <file>", "error");
        return;
      }
      ctx.client.addToPlaylist(arg);
    },
  },
  {
    name: "queueandselect",
    aliases: ["queueandselect", "qas"],
    tier: "basic",
    usage: "/queueandselect, /qas <file>  add and switch",
    handler: (ctx, arg) => {
      if (!arg) {
        ctx.pushLine("Usage: /queueandselect <file>", "error");
        return;
      }
      ctx.client.addToPlaylist(arg);
      ctx.client.selectPlaylistIndex(ctx.client.playlist.files.length - 1);
    },
  },
  {
    name: "select",
    aliases: ["select", "qs"],
    tier: "basic",
    usage: "/select, /qs <n>        select playlist item",
    handler: (ctx, arg) => {
      const index = parsePlaylistIndex(arg, ctx.client.playlist.files.length);
      if (index === null) {
        ctx.pushLine(`Invalid playlist index: ${arg}`, "error");
        return;
      }
      ctx.client.selectPlaylistIndex(index);
    },
  },
  {
    name: "next",
    aliases: ["next", "qn"],
    tier: "basic",
    usage: "/next, /qn              next item",
    handler: (ctx) => {
      ctx.client.loadNextFileInPlaylist();
    },
  },
  {
    name: "seek",
    aliases: ["seek", "s"],
    tier: "basic",
    usage: "/seek, /s <sec>         seek (+/- for relative)",
    handler: (ctx, arg) => {
      const parsed = parseSignedOrAbsolute(arg);
      if (!parsed) {
        ctx.pushLine("Usage: /seek <sec>  e.g. /seek 90  /seek +5  /seek -5", "error");
        return;
      }
      if (parsed.relative) ctx.client.seekRelative(parsed.value);
      else ctx.client.seekTo(parsed.value);
    },
  },
  {
    name: "setup",
    aliases: ["setup"],
    tier: "basic",
    usage: "/setup                  setup wizard",
    handler: (ctx) => ctx.onSetup?.(),
  },
  {
    name: "config",
    aliases: ["config", "settings"],
    tier: "basic",
    usage: "/config, /settings      settings",
    handler: (ctx) => ctx.onSettings?.(),
  },
  {
    name: "help",
    aliases: ["help", "h", "?"],
    tier: "basic",
    usage: "/help, /h               this help",
    handler: (ctx) => renderHelp(ctx.powerUserMode).forEach((line) => ctx.pushLine(line)),
  },
  {
    name: "status",
    aliases: ["status", "st"],
    tier: "basic",
    usage: "/status, /st            show connection and session info",
    handler: (ctx) => showStatus(ctx),
  },
  {
    name: "exit",
    aliases: ["exit", "quit"],
    tier: "basic",
    usage: "/exit, /quit            quit",
    handler: (ctx) => ctx.onExit?.(),
  },

  // --- power tier ---
  {
    name: "setready",
    aliases: ["setready", "sr"],
    tier: "power",
    usage: "/setready, /sr <user>   mark another user ready",
    handler: (ctx, arg) => {
      if (arg) ctx.client.setOthersReadiness(arg.trim(), true);
    },
  },
  {
    name: "setnotready",
    aliases: ["setnotready", "snr"],
    tier: "power",
    usage: "/setnotready, /snr <user>  mark another user not ready",
    handler: (ctx, arg) => {
      if (arg) ctx.client.setOthersReadiness(arg.trim(), false);
    },
  },
  {
    name: "offset",
    aliases: ["offset", "o"],
    tier: "power",
    usage: "/offset, /o <sec>       set A/V offset; +/-<sec> for relative",
    handler: (ctx, arg) => {
      const parsed = parseSignedOrAbsolute(arg);
      if (!parsed) {
        ctx.pushLine("Usage: /offset <sec>  e.g. /offset 0.5  /offset +0.1", "error");
        return;
      }
      ctx.client.setUserOffset(parsed.relative ? ctx.client.userOffsetSeconds + parsed.value : parsed.value);
    },
  },
  {
    name: "list",
    aliases: ["list", "l", "users"],
    tier: "power",
    usage: "/list, /l, /users       list users per room",
    handler: (ctx) => listUsers(ctx),
  },
  {
    name: "auth",
    aliases: ["auth", "a"],
    tier: "power",
    usage: "/auth <pass>            authenticate operator",
    handler: (ctx, arg) => {
      if (arg) ctx.client.requestControl(ctx.room, arg);
    },
  },
  {
    name: "undo",
    aliases: ["undo", "u", "revert"],
    tier: "power",
    usage: "/undo, /u, /revert      undo playlist change",
    handler: (ctx) => ctx.client.undoPlaylist(),
  },
  {
    name: "delete",
    aliases: ["delete", "qd", "d"],
    tier: "power",
    usage: "/delete, /qd, /d <n>    remove playlist item (or use panel navigation)",
    handler: (ctx, arg) => {
      const index = parsePlaylistIndex(arg, ctx.client.playlist.files.length);
      if (index === null) {
        ctx.pushLine(`Invalid playlist index: ${arg}`, "error");
        return;
      }
      ctx.client.removeFromPlaylist(index);
    },
  },
  {
    name: "create",
    aliases: ["create", "c"],
    tier: "power",
    usage: "/create, /c [room]      create managed room (defaults to current room)",
    handler: (ctx, arg) => {
      // No argument: fall back to the current room — mirrors consoleUI.py's COMMANDS_CREATE
      // handling (~line 181-186), which uses getRoom() as the roombasename default.
      const target = arg || ctx.client.currentRoom;
      if (target) ctx.client.requestControl(target, "");
    },
  },
  {
    name: "set",
    aliases: ["set"],
    tier: "power",
    usage: "/set <k> <v>            set option",
    handler: (ctx, arg) => {
      const space = arg.indexOf(" ");
      if (space === -1) {
        ctx.pushLine("Usage: /set <key> <value>  e.g. /set name ata  /set port 8311", "error");
        return;
      }
      const key = arg.slice(0, space);
      const value = arg.slice(space + 1);
      if (ctx.onSet) {
        const msg = ctx.onSet(key, value);
        ctx.pushLine(msg, msg.startsWith("Unknown") ? "error" : "system");
      }
    },
  },
  {
    name: "chat",
    aliases: ["chat", "ch"],
    tier: "power",
    usage: "/chat, /ch <text>       send a chat message",
    handler: (ctx, arg) => {
      if (!arg) return;
      ctx.client.sendChat(arg);
    },
  },
  {
    name: "playlist",
    aliases: ["playlist", "ql", "pl"],
    tier: "power",
    usage: "/playlist, /pl          show playlist",
    handler: (ctx) => showPlaylist(ctx),
  },
  {
    name: "toggle-power-user",
    aliases: ["toggle-power-user"],
    tier: "power",
    usage: "/toggle-power-user      toggle power-user mode (turn it back off)",
    handler: (ctx) => {
      const next = !ctx.powerUserMode;
      ctx.setPowerUserMode(next);
      ctx.pushLine(`Power-user mode ${next ? "enabled" : "disabled"}.`);
    },
  },
];
