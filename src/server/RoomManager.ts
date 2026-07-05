// See ../../../spec/server/rooms-and-permissions.md#room-lifecycle and #room-isolation.

import { isControlledRoomName } from "../protocol/roomPassword.js";
import { Room, ControlledRoom } from "./Room.js";
import type { Watcher } from "./Watcher.js";
import type { RoomRecord, RoomsStore } from "./persistence.js";

export interface RoomManagerOptions {
  /** --isolate-rooms: scopes broadcasts/userlists to the sender's own room only. */
  isolateRooms: boolean;
  /**
   * --rooms-db-file backend. Per spec/server/rooms-and-permissions.md#room-isolation, the
   * reference server drops rooms-db/permanent-rooms support entirely under --isolate-rooms - the
   * caller (SyncServer) is responsible for not passing these when isolateRooms is set.
   */
  roomsStore?: RoomsStore;
  /** --permanent-rooms-file contents: room names that survive being emptied. */
  permanentRoomNames?: Set<string>;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  readonly isolateRooms: boolean;
  private readonly roomsStore: RoomsStore | null;
  private readonly permanentRoomNames: Set<string>;
  /**
   * Cache of persisted room state, keyed by name. Unlike the reference server, we don't keep an
   * empty persistent room's `Room` object alive in `rooms` forever - it's dropped like any other
   * empty room (see deleteRoomIfEmpty below) and its last-known state lives here instead, ready
   * to rehydrate a fresh `Room` object if/when the name is referenced again via getOrCreateRoom.
   */
  private readonly persistedRecords = new Map<string, RoomRecord>();

  constructor(options: RoomManagerOptions) {
    this.isolateRooms = options.isolateRooms;
    this.roomsStore = options.roomsStore ?? null;
    this.permanentRoomNames = options.permanentRoomNames ?? new Set();
    if (this.roomsStore) {
      for (const record of this.roomsStore.loadAll()) {
        this.persistedRecords.set(record.name, record);
      }
    }
  }

  getRoom(name: string): Room | undefined {
    return this.rooms.get(name);
  }

  getOrCreateRoom(name: string): Room {
    let room = this.rooms.get(name);
    if (!room) {
      room = isControlledRoomName(name) ? new ControlledRoom(name) : new Room(name);
      if (this.permanentRoomNames.has(name)) room.permanent = true;
      const persisted = this.persistedRecords.get(name);
      if (persisted) {
        room.playlist = persisted.playlist;
        room.playlistIndex = persisted.playlistIndex;
        room.position = persisted.position;
      }
      this.rooms.set(name, room);
    }
    return room;
  }

  /** Room names ending in "-temp" or containing "-temp:" are always treated as non-persistent. */
  private isMarkedTemporary(name: string): boolean {
    return name.endsWith("-temp") || name.includes("-temp:");
  }

  /** Write-through save, called by SyncServer whenever a room's playlist/index changes. */
  persistRoom(room: Room): void {
    if (!this.roomsStore || this.isMarkedTemporary(room.name)) return;
    const record: RoomRecord = {
      name: room.name,
      playlist: room.playlist,
      playlistIndex: room.playlistIndex,
      position: room.position,
      lastSavedUpdate: Date.now(),
    };
    this.persistedRecords.set(room.name, record);
    this.roomsStore.save(record);
  }

  deleteRoomIfEmpty(room: Room): void {
    if (!room.isEmpty) return;
    if (room.permanent) return;
    if (this.roomsStore && !this.isMarkedTemporary(room.name)) {
      // Keep the playlist on disk (if there's anything worth keeping) so a later
      // getOrCreateRoom() for this name can restore it - see the persistedRecords doc comment.
      if (room.playlist.length > 0) {
        this.persistRoom(room);
      } else {
        this.persistedRecords.delete(room.name);
        this.roomsStore.delete(room.name);
      }
    }
    this.rooms.delete(room.name);
  }

  close(): void {
    this.roomsStore?.close();
  }

  allWatchers(): Watcher[] {
    return [...this.rooms.values()].flatMap((r) => [...r.watchers.values()]);
  }

  /** Watchers a given watcher's client should see in userlists (room-scoped if isolated). */
  visibleWatchers(forRoom: Room): Watcher[] {
    if (this.isolateRooms) return [...forRoom.watchers.values()];
    return this.allWatchers();
  }

  visibleRooms(forRoom: Room): Room[] {
    if (this.isolateRooms) return [forRoom];
    return [...this.rooms.values()];
  }

  /**
   * Case-insensitive de-duplication across *every* room (not per-room). Strips any trailing
   * underscores the requested name already had first (deterministic minimal re-suffixing), then
   * appends single underscores until unique. See spec/server/rooms-and-permissions.md.
   */
  findFreeUsername(desired: string, maxLen: number): string {
    let username = desired.slice(0, maxLen);
    const allNamesLower = new Set(this.allWatchers().map((w) => w.name.toLowerCase()));

    if (allNamesLower.has(username.toLowerCase()) && username.endsWith("_")) {
      username = username.replace(/_+$/, "") || "_";
    }
    while (allNamesLower.has(username.toLowerCase())) {
      username += "_";
    }
    return username;
  }
}
