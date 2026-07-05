// Wire message shapes. See ../../../spec/protocol/message-reference.md for the authoritative
// field-by-field description these types mirror.

export interface FileInfo {
  name: string;
  duration: number;
  /** Normally a byte count, but becomes a 12-hex-char string under hashed-filesize privacy mode. */
  size: number | string;
}

export interface HelloRoom {
  name: string;
}

export interface HelloMessage {
  username: string;
  password?: string;
  room?: HelloRoom;
  version: string;
  realversion: string;
  features?: Record<string, unknown>;
  motd?: string;
}

export interface PlayState {
  position?: number;
  paused?: boolean;
  doSeek?: boolean;
  setBy?: string | null;
}

export interface PingBlock {
  latencyCalculation?: number;
  clientLatencyCalculation?: number;
  clientRtt?: number;
  serverRtt?: number;
}

export interface IgnoringOnTheFly {
  server?: number;
  client?: number;
}

export interface StateMessage {
  playstate?: PlayState;
  ping?: PingBlock;
  ignoringOnTheFly?: IgnoringOnTheFly;
}

export interface SetRoom {
  room?: { name: string; password?: string };
}

export interface SetUserEvent {
  joined?: boolean;
  left?: boolean;
  version?: string;
  features?: Record<string, unknown>;
}

export interface SetUserEntry {
  room?: HelloRoom;
  file?: FileInfo;
  event?: SetUserEvent;
}

export interface SetControllerAuthRequest {
  room: string;
  password: string;
}

export interface SetControllerAuthResponse {
  user: string;
  room: string;
  success: boolean;
}

export interface SetNewControlledRoom {
  password: string;
  roomName: string;
}

export interface SetReadyRequest {
  isReady: boolean;
  manuallyInitiated: boolean;
  username?: string;
}

export interface SetReadyResponse {
  username: string;
  isReady: boolean;
  manuallyInitiated: boolean;
  setBy?: string;
}

export interface SetPlaylistIndexRequest {
  index: number;
}
export interface SetPlaylistIndexResponse {
  user: string;
  index: number;
}

export interface SetPlaylistChangeRequest {
  files: string[];
}
export interface SetPlaylistChangeResponse {
  user: string;
  files: string[];
}

export interface SetMessage {
  room?: SetRoom["room"];
  user?: Record<string, SetUserEntry>;
  file?: FileInfo;
  controllerAuth?: SetControllerAuthRequest | SetControllerAuthResponse;
  newControlledRoom?: SetNewControlledRoom;
  ready?: SetReadyRequest | SetReadyResponse;
  playlistIndex?: SetPlaylistIndexRequest | SetPlaylistIndexResponse;
  playlistChange?: SetPlaylistChangeRequest | SetPlaylistChangeResponse;
  features?: Record<string, unknown>;
}

export type ListUserEntry = {
  position: 0;
  file: FileInfo | Record<string, never>;
  controller: boolean;
  isReady: boolean | null;
  features: Record<string, unknown>;
};

export type ListMessage = Record<string, Record<string, ListUserEntry>>;

export interface ErrorMessage {
  message: string;
}

export type ChatClientToServer = string;
export interface ChatServerToClient {
  username: string;
  message: string;
}

export interface TLSMessage {
  startTLS: "send" | "true" | "false";
}

/** Top-level envelope: one JSON object per line, keyed by command name. */
export interface Envelope {
  Hello?: HelloMessage;
  Set?: SetMessage;
  List?: null | ListMessage;
  State?: StateMessage;
  Error?: ErrorMessage;
  Chat?: ChatClientToServer | ChatServerToClient;
  TLS?: TLSMessage;
}

export type CommandName = keyof Envelope;
