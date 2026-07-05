// Shared playlist client-side state. See ../../../spec/client/playlist-and-readiness.md and
// ../../../spec/data-model.md#syncplayplaylist.

import { isURL, removeDirsFromPath } from "./mediaUtils.js";

export class Playlist {
  files: string[] = [];
  index: number | null = null;

  private previousFiles: string[] | null = null;
  private previousIndex: number | null = null;

  /** A remote (or room-join) update - not pushed back to the server. */
  setFromRemote(files: string[], index?: number): void {
    this.previousFiles = this.files;
    this.previousIndex = this.index;
    this.files = files;
    if (index !== undefined) this.index = index;
  }

  setIndexFromRemote(index: number): void {
    this.index = index;
  }

  /** A locally-initiated change - caller is responsible for pushing it to the server. */
  setLocal(files: string[]): void {
    this.previousFiles = this.files;
    this.previousIndex = this.index;
    this.files = files;
  }

  add(file: string): string[] {
    const entry = isURL(file) ? file : removeDirsFromPath(file);
    return [...this.files, entry];
  }

  deleteAt(i: number): string[] {
    const copy = [...this.files];
    copy.splice(i, 1);
    return copy;
  }

  canUndo(): boolean {
    return this.previousFiles !== null;
  }

  undo(): { files: string[]; index: number | null } | null {
    if (this.previousFiles === null) return null;
    const result = { files: this.previousFiles, index: this.previousIndex };
    this.previousFiles = null;
    this.previousIndex = null;
    return result;
  }

  currentFile(): string | null {
    if (this.index === null) return null;
    return this.files[this.index] ?? null;
  }

  /**
   * The reconnection-restoration heuristic: an empty, no-username playlistChange right after
   * reconnecting is interpreted as "the room forgot my playlist" rather than a real remote edit.
   * See spec/client/reconnection-and-resilience.md#playlist-restoration.
   */
  needsRestoring(receivedFiles: string[], fromRemoteUser: boolean, mayNeedRestoring: boolean): boolean {
    return mayNeedRestoring && !fromRemoteUser && receivedFiles.length === 0 && this.files.length > 0;
  }
}
