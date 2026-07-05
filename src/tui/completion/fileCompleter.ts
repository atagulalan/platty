// File-path completion for /qa, /qas, /add, /queue, /queueandselect.
// See ../../../../spec/config/tui-ux-plan.md Phase 3's "File completer for /qa <path>" subsection.
//
//   /qa /home/xava/Mov          -> list /home/xava/Movies/*
//   /qa /home/xava/Movies/foo   -> foo.mkv, foo.srt, ...
//
// Deliberately synchronous (readdirSync) — completion has to be instant per keystroke.
// Basename-only fallback (scanning FileSwitchManager's mediaSearchDirectories cache) is not
// implemented here: that cache is private to FileSwitchManager and not exposed to the TUI layer,
// so a bare `/qa foo` (no slash, no `~`) simply yields no suggestions from this module.

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_COMPLETION_RESULTS } from "./types.js";

/**
 * Return path completions for a partial `/qa <path>` argument.
 * Returns [] (never throws) when the partial isn't path-like, or the directory can't be read.
 */
export function completeFilePath(partial: string): string[] {
  if (!partial) return [];

  let expanded = partial;
  if (expanded === "~") {
    expanded = `${homedir()}/`;
  } else if (expanded.startsWith("~/")) {
    expanded = join(homedir(), expanded.slice(2));
  }

  if (!expanded.includes("/")) {
    // No directory component and no `~` expansion — basename/media-cache fallback not wired up.
    return [];
  }

  const lastSlash = expanded.lastIndexOf("/");
  const dirPart = expanded.slice(0, lastSlash) || "/";
  const basePart = expanded.slice(lastSlash + 1);

  let entries;
  try {
    entries = readdirSync(dirPart, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs: string[] = [];
  const files: string[] = [];
  for (const entry of entries) {
    const name = entry.name.toString();
    if (!name.startsWith(basePart)) continue;
    const full = join(dirPart, name);
    if (entry.isDirectory()) {
      dirs.push(`${full}/`);
    } else {
      files.push(full);
    }
  }

  dirs.sort();
  files.sort();
  return [...dirs, ...files].slice(0, MAX_COMPLETION_RESULTS);
}
