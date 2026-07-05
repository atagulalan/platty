// Room / ControlledRoom data model. See ../../spec/data-model.md and
// ../../spec/server/rooms-and-permissions.md.
//
// Simplification vs. the reference implementation: Python has a separate `PublicRoomManager`
// subclass purely to change broadcast *scope* under --isolate-rooms. Here that's a boolean flag
// on RoomManager instead (see RoomManager.ts) - same externally-observable behavior, one less
// class hierarchy.

import type { Watcher } from "./Watcher.js";

export class Room {
  readonly watchers = new Map<string, Watcher>();
  playlist: string[] = [];
  playlistIndex: number | null = null;
  paused = true;
  position = 0;
  setBy: string | null = null;
  permanent = false;
  lastUpdate = Date.now();

  constructor(public readonly name: string) {}

  /** Non-controlled rooms have no permission gating at all. */
  canControl(_watcher: Watcher): boolean {
    return true;
  }

  isController(_watcher: Watcher): boolean {
    return false;
  }

  addWatcher(watcher: Watcher): void {
    this.watchers.set(watcher.name, watcher);
  }

  removeWatcher(name: string): void {
    this.watchers.delete(name);
  }

  get isEmpty(): boolean {
    return this.watchers.size === 0;
  }

  /**
   * Authoritative position = whichever connected watcher (with a file loaded) is furthest
   * behind, re-derived on demand rather than persistently "owned" by whoever last acted.
   * See spec/server/rooms-and-permissions.md#position-authority.
   */
  getPosition(): number {
    let min: number | null = null;
    for (const w of this.watchers.values()) {
      if (!w.file) continue;
      if (min === null || w.position < min) min = w.position;
    }
    return min ?? this.position;
  }

  isPaused(): boolean {
    for (const w of this.watchers.values()) {
      if (w.file && !w.paused) return false;
    }
    return this.paused;
  }
}

export class ControlledRoom extends Room {
  readonly controllers = new Set<string>();

  override canControl(watcher: Watcher): boolean {
    return this.controllers.has(watcher.name);
  }

  override isController(watcher: Watcher): boolean {
    return this.controllers.has(watcher.name);
  }

  addController(name: string): void {
    this.controllers.add(name);
  }
}
