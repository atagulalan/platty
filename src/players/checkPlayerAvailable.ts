import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:process";
import type { PlayerKind } from "../config/types.js";

const DEFAULT_EXECUTABLE: Record<Exclude<PlayerKind, "null">, string> = {
  mpv: "mpv",
  vlc: "vlc",
  mpvnet: "mpvnet",
  iina: "iina-cli",
  memento: "memento",
};

export type PlayerAvailability = { ok: true } | { ok: false; message: string };

export function resolvePlayerExecutable(kind: PlayerKind, playerPath?: string): string {
  if (kind === "null") return "";
  const trimmed = playerPath?.trim();
  if (trimmed) return trimmed;
  return DEFAULT_EXECUTABLE[kind];
}

function looksLikeFilesystemPath(executable: string): boolean {
  return executable.includes("/") || executable.includes("\\") || /^[a-zA-Z]:/.test(executable);
}

export function isPlayerFilesystemPath(value: string): boolean {
  return looksLikeFilesystemPath(value.trim());
}

function checkOnPath(executable: string): Promise<PlayerAvailability> {
  const whichCmd = platform === "win32" ? "where.exe" : "which";
  return new Promise((resolve) => {
    execFile(whichCmd, [executable], (err) => {
      if (err) {
        resolve({
          ok: false,
          message: `Could not find "${executable}" on PATH. Install it or set playerPath to the full executable path.`,
        });
        return;
      }
      resolve({ ok: true });
    });
  });
}

/** Returns whether the configured player executable can be launched (null player always passes). */
export function checkPlayerAvailable(
  kind: PlayerKind,
  playerPath?: string,
): Promise<PlayerAvailability> {
  if (kind === "null") return Promise.resolve({ ok: true });

  const executable = resolvePlayerExecutable(kind, playerPath);
  const label = kind;

  if (looksLikeFilesystemPath(executable)) {
    if (!existsSync(executable)) {
      return Promise.resolve({
        ok: false,
        message: `Could not find ${label} at "${executable}". Check the path or install ${label}.`,
      });
    }
    return Promise.resolve({ ok: true });
  }

  return checkOnPath(executable).then((result) =>
    result.ok
      ? result
      : {
          ok: false,
          message: `Could not find ${label} on PATH ("${executable}"). Install ${label} or set playerPath to the full executable path.`,
        },
  );
}
