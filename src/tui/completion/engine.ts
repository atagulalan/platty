// Completion engine — maps the current input line + cursor to a list of candidate replacements.
// See ../../spec/config/tui-ux-plan.md Phase 3's "Completion sources" table.

import { COMMAND_REGISTRY } from "../commands/registry.js";
import type { UserInfo } from "../../client/UserList.js";
import { completeFilePath } from "./fileCompleter.js";
import type { CompletionRequest, CompletionResult } from "./types.js";
import { MAX_COMPLETION_RESULTS } from "./types.js";

export interface CompletionEngineContext {
  powerUserMode: boolean;
  playlistFiles: string[];
  users: UserInfo[];
  settableKeys: string[];
}

const FILE_COMMANDS = new Set(["add", "queueandselect"]);
const PLAYLIST_INDEX_COMMANDS = new Set(["select", "delete"]);
const USERNAME_COMMANDS = new Set(["setready", "setnotready"]);
const ROOM_COMMANDS = new Set(["room"]);
const SET_COMMANDS = new Set(["set"]);

function startsWithCaseInsensitive(value: string, prefix: string): boolean {
  return value.toLowerCase().startsWith(prefix.toLowerCase());
}

function completeCommandName(partial: string, powerUserMode: boolean): string[] {
  const names = COMMAND_REGISTRY.filter((c) => powerUserMode || c.tier === "basic").flatMap((c) => c.aliases);
  const matches = [...new Set(names)]
    .filter((name) => name.startsWith(partial.toLowerCase()))
    .sort();
  return matches.map((name) => `/${name}`).slice(0, MAX_COMPLETION_RESULTS);
}

function completePlaylistIndex(arg: string, files: string[]): string[] {
  const trimmed = arg.trim();
  const indices = files.map((_, i) => String(i + 1));
  if (!trimmed) return indices.slice(0, MAX_COMPLETION_RESULTS);

  const byIndex = indices.filter((n) => n.startsWith(trimmed));
  const byName = files
    .map((file, i) => ({ file, index: String(i + 1) }))
    .filter(({ file }) => file.toLowerCase().includes(trimmed.toLowerCase()))
    .map(({ index }) => index);

  return [...new Set([...byIndex, ...byName])].slice(0, MAX_COMPLETION_RESULTS);
}

function completeSettableKey(arg: string, settableKeys: string[]): string[] {
  // Only complete the key itself (first token); once a space appears the user is typing the value.
  if (arg.includes(" ")) return [];
  return settableKeys
    .filter((key) => startsWithCaseInsensitive(key, arg))
    .sort()
    .slice(0, MAX_COMPLETION_RESULTS);
}

function completeUsername(arg: string, users: UserInfo[]): string[] {
  const names = [...new Set(users.map((u) => u.username))];
  return names
    .filter((name) => startsWithCaseInsensitive(name, arg))
    .sort()
    .slice(0, MAX_COMPLETION_RESULTS);
}

function completeRoom(arg: string, users: UserInfo[]): string[] {
  const rooms = [...new Set(users.map((u) => u.room).filter((room) => room.length > 0))];
  return rooms
    .filter((room) => startsWithCaseInsensitive(room, arg))
    .sort()
    .slice(0, MAX_COMPLETION_RESULTS);
}

/** Compute completions for the current input line, given the cursor position and live client state. */
export function getCompletions(request: CompletionRequest, ctx: CompletionEngineContext): CompletionResult {
  const cursor = Math.max(0, Math.min(request.cursor, request.line.length));
  const head = request.line.slice(0, cursor);

  if (!head.startsWith("/") || head.startsWith("//")) {
    return { suggestions: [], replaceFrom: cursor };
  }

  const body = head.slice(1);
  const spaceIndex = body.indexOf(" ");

  if (spaceIndex === -1) {
    // Still typing the command name itself — complete against the whole line from position 0.
    return { suggestions: completeCommandName(body, ctx.powerUserMode), replaceFrom: 0 };
  }

  const cmdToken = body.slice(0, spaceIndex).toLowerCase();
  const arg = body.slice(spaceIndex + 1);
  const replaceFrom = 1 + spaceIndex + 1; // past "/" + cmdToken + " "

  const def = COMMAND_REGISTRY.find((d) => d.aliases.includes(cmdToken));
  if (!def) return { suggestions: [], replaceFrom: cursor };

  let suggestions: string[] = [];
  if (FILE_COMMANDS.has(def.name)) {
    suggestions = completeFilePath(arg);
  } else if (PLAYLIST_INDEX_COMMANDS.has(def.name)) {
    suggestions = completePlaylistIndex(arg, ctx.playlistFiles);
  } else if (SET_COMMANDS.has(def.name)) {
    suggestions = completeSettableKey(arg, ctx.settableKeys);
  } else if (USERNAME_COMMANDS.has(def.name)) {
    suggestions = completeUsername(arg, ctx.users);
  } else if (ROOM_COMMANDS.has(def.name)) {
    suggestions = completeRoom(arg, ctx.users);
  }

  return { suggestions, replaceFrom };
}
