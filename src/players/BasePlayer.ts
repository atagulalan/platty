// The player integration contract. See ../../../spec/players/abstraction-and-selection.md and
// ../../../spec/client/overview-and-state-machine.md#player-callback-contract.

import type { EventEmitter } from "node:events";
import type { OsdMood, OsdType } from "./mpvSyncplayIntf.js";

export interface PlayerStatus {
  paused: boolean;
  /** Seconds. */
  position: number;
}

export interface PlayerFileInfo {
  name: string;
  path: string;
  /** Seconds. */
  duration: number;
}

export interface DisplayMessageOptions {
  /** Legacy alias: maps to osdType "alert" when true (VLC center channel). */
  osdOnly?: boolean;
  /** Duration in seconds (Python passes milliseconds; mpv script uses seconds via constants). */
  duration?: number;
  osdType?: OsdType;
  mood?: OsdMood;
}

export interface PlayerEvents {
  status: [PlayerStatus];
  fileInfo: [PlayerFileInfo];
  close: [];
  error: [Error];
  /** mpv syncplayintf.lua chat input — user typed a message in the player overlay. */
  chatInput: [string];
  /** mpv syncplayintf.lua EOF observer — end of file reached. */
  eof: [];
}

export interface Player extends EventEmitter {
  readonly name: string;
  readonly speedSupported: boolean;
  /** When false, PlayerPresenter merges alert+notification on one channel (VLC). Default true. */
  readonly alertOsdSupported?: boolean;
  readonly osdMessageSeparator?: string;

  open(filePath: string): Promise<void>;
  setPaused(paused: boolean): void;
  setPosition(seconds: number): void;
  setSpeed(rate: number): void;
  quit(): void;

  displayMessage(text: string, options?: DisplayMessageOptions): void;
  /** mpv-only: routes chat through syncplayintf.lua's persistent overlay. */
  displayChatMessage?(username: string, message: string): void;

  on<K extends keyof PlayerEvents>(event: K, listener: (...args: PlayerEvents[K]) => void): this;
  emit<K extends keyof PlayerEvents>(event: K, ...args: PlayerEvents[K]): boolean;
}
