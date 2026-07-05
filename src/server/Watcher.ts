// Server-side façade around one connected client. See ../../spec/data-model.md#watcher.

import type { FileInfo } from "../protocol/types.js";
import type { Room } from "./Room.js";
import type { ServerConnection } from "./ServerConnection.js";

export class Watcher {
  file: FileInfo | null = null;
  position = 0;
  paused = true;
  /** null = readiness feature disabled/unset. */
  ready: boolean | null = null;
  lastUpdatedOn = Date.now();
  /** Per-watcher "on the fly" counters, mirrored from the connection's protocol state. */

  constructor(
    public readonly connection: ServerConnection,
    public name: string,
    public room: Room,
  ) {}

  isController(): boolean {
    return this.room.isController(this);
  }

  touch(): void {
    this.lastUpdatedOn = Date.now();
  }
}
