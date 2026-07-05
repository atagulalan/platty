// Resolves shared-playlist filenames to local paths by scanning mediaSearchDirectories.
// See ../../spec/client/playlist-and-readiness.md#resolving-a-playlist-entry-to-a-local-file
// and source/syncplay/client.py:2202-2333.

import { readdirSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { sameFilename } from "./privacy.js";
import { FOLDER_SEARCH_DOUBLE_CHECK_INTERVAL_MS } from "../protocol/constants.js";

export class FileSwitchManager {
  private mediaDirectories: string[] = [];
  private mediaFilesCache = new Map<string, string[]>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshing = false;

  setMediaDirectories(directories: string[]): void {
    this.mediaDirectories = directories.filter(Boolean);
    void this.refreshCache();
    this.restartTimer();
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  /**
   * Locate a playlist entry on disk. Checks the currently-open file first, then the background
   * cache, then probes each configured media directory directly and recursively.
   */
  findFilepath(filename: string | null | undefined, currentFile?: { name: string; path: string } | null): string | null {
    if (!filename) return null;

    if (currentFile && sameFilename(filename, currentFile.name) && currentFile.path) {
      return currentFile.path;
    }

    for (const [directory, files] of this.mediaFilesCache.entries()) {
      if (files.includes(filename)) {
        const filepath = join(directory, filename);
        try {
          if (statSync(filepath).isFile()) return filepath;
        } catch {
          /* cache entry stale */
        }
      }
    }

    for (const directory of this.mediaDirectories) {
      const filepath = join(directory, filename);
      try {
        if (statSync(filepath).isFile()) {
          return filepath;
        }
      } catch {
        /* not at top level */
      }

      const nested = findFileInTree(directory, filename);
      if (nested) {
        return nested;
      }
    }

    return null;
  }

  private restartTimer(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.mediaDirectories.length === 0) return;
    this.refreshTimer = setInterval(() => void this.refreshCache(), FOLDER_SEARCH_DOUBLE_CHECK_INTERVAL_MS);
  }

  private async refreshCache(): Promise<void> {
    if (this.refreshing || this.mediaDirectories.length === 0) return;
    this.refreshing = true;
    try {
      const nextCache = new Map<string, string[]>();
      for (const root of this.mediaDirectories) {
        await walkDirectory(root, nextCache);
      }
      this.mediaFilesCache = nextCache;
    } finally {
      this.refreshing = false;
    }
  }
}

function findFileInTree(root: string, filename: string): string | null {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const name = entry.name.toString();
    const fullPath = join(root, name);
    if (entry.isFile() && name === filename) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const nested = findFileInTree(fullPath, filename);
      if (nested) return nested;
    }
  }
  return null;
}

async function walkDirectory(root: string, cache: Map<string, string[]>): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const name = entry.name.toString();
    if (entry.isFile()) {
      files.push(name);
    } else if (entry.isDirectory()) {
      await walkDirectory(join(root, name), cache);
    }
  }
  if (files.length > 0) cache.set(root, files);
}
