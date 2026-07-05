// Room membership + readiness aggregation. See ../../spec/data-model.md#syncplayuserlist and
// ../../spec/client/playlist-and-readiness.md.

import type { FileInfo } from "../protocol/types.js";
import { sameFileDuration, sameFilename, sameFilesize } from "./privacy.js";

export interface UserInfo {
  username: string;
  room: string;
  file: FileInfo | null;
  ready: boolean | null;
  controller: boolean;
}

export class UserList {
  private readonly users = new Map<string, UserInfo>();

  upsert(username: string, patch: Partial<Omit<UserInfo, "username">>): UserInfo {
    const existing = this.users.get(username) ?? {
      username,
      room: "",
      file: null,
      ready: null,
      controller: false,
    };
    const updated: UserInfo = { ...existing, ...patch };
    this.users.set(username, updated);
    return updated;
  }

  remove(username: string): void {
    this.users.delete(username);
  }

  clear(): void {
    this.users.clear();
  }

  get(username: string): UserInfo | undefined {
    return this.users.get(username);
  }

  all(): UserInfo[] {
    return [...this.users.values()];
  }

  inRoom(room: string): UserInfo[] {
    return this.all().filter((u) => u.room === room);
  }

  /** Mirrors SyncplayUser.isReadyWithFile() — null when no file, else the ready flag. */
  readyWithFileState(user: UserInfo): boolean | null {
    if (user.file === null) return null;
    return user.ready === true;
  }

  /** Mirrors userlist.usersInRoomCount() — always counts self as 1, plus others with a file who are ready. */
  usersInRoomCount(room: string, selfUsername: string): number {
    let count = 1;
    for (const u of this.inRoom(room)) {
      if (u.username === selfUsername) continue;
      if (this.readyWithFileState(u) === true) count++;
    }
    return count;
  }

  /** Mirrors userlist.readyUserCount(). */
  readyUserCount(room: string, selfUsername: string): number {
    let count = 0;
    const self = this.get(selfUsername);
    if (self?.ready === true) count++;
    for (const u of this.inRoom(room)) {
      if (u.username === selfUsername) continue;
      if (this.readyWithFileState(u) === true) count++;
    }
    return count;
  }

  /** Mirrors userlist.onlyUserInRoomWhoSupportsReadiness(). */
  onlyUserInRoomWhoSupportsReadiness(room: string, selfUsername: string): boolean {
    for (const u of this.inRoom(room)) {
      if (u.username === selfUsername) continue;
      if (this.readyWithFileState(u) !== null) return false;
    }
    return true;
  }

  /** Mirrors userlist.areAllUsersInRoomReady(). */
  areAllUsersInRoomReady(room: string, selfUsername: string, requireSameFilenames = false): boolean {
    const self = this.get(selfUsername);
    if (!self || self.ready !== true) return false;
    for (const u of this.inRoom(room)) {
      if (u.username === selfUsername) continue;
      if (this.readyWithFileState(u) === false) return false;
      if (
        requireSameFilenames &&
        self.file &&
        u.file &&
        !sameFilename(self.file.name, u.file.name)
      ) {
        return false;
      }
    }
    return true;
  }

  /** Mirrors userlist.areAllOtherUsersInRoomReady(). */
  areAllOtherUsersInRoomReady(room: string, selfUsername: string): boolean {
    for (const u of this.inRoom(room)) {
      if (u.username === selfUsername) continue;
      if (this.readyWithFileState(u) === false) return false;
    }
    return true;
  }

  /** Does every user in the room appear to have the same file loaded (name+size+duration)? */
  areAllFilesInRoomSame(room: string): boolean {
    const files = this.inRoom(room)
      .map((u) => u.file)
      .filter((f): f is FileInfo => f !== null);
    if (files.length < 2) return true;
    const [first, ...rest] = files;
    return rest.every(
      (f) =>
        sameFilename(first!.name, f.name) &&
        sameFilesize(first!.size, f.size) &&
        sameFileDuration(first!.duration, f.duration),
    );
  }
}
