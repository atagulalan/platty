// Splatty configuration — mirrors Syncplay's syncplay.ini schema (see spec/config/cli-and-settings-reference.md)
// plus a small [splatty] section for TUI-specific options.

import type { PrivacyMode } from "../protocol/constants.js";

// mplayer/mpc-hc/mpc-be are deliberately excluded here: playerFactory.ts stubs them with a
// hard "not supported" error, so they're not worth persisting/offering as a saved setting.
export type PlayerKind = "mpv" | "vlc" | "null" | "mpvnet" | "iina" | "memento";

export type UnpauseAction = "IfAlreadyReady" | "IfOthersReady" | "IfMinUsersReady" | "Always";

export type ChatOutputMode = "Chatroom" | "Scrolling";

export type ChatInputPosition = "Top" | "Middle" | "Bottom";

export interface SplattyConfig {
  // server_data
  host: string;
  port: number;
  password: string;

  // client_settings — connection
  name: string;
  room: string;
  roomList: string[];
  playerPath: string;
  perPlayerArguments: Record<string, string>;
  mediaSearchDirectories: string[];

  // client_settings — sync
  slowdownThreshold: number;
  rewindThreshold: number;
  fastforwardThreshold: number;
  folderSearchFirstFileTimeout: number;
  folderSearchTimeout: number;
  folderSearchDoubleCheckInterval: number;
  folderSearchWarningThreshold: number;
  slowOnDesync: boolean;
  rewindOnDesync: boolean;
  fastforwardOnDesync: boolean;
  dontSlowDownWithMe: boolean;

  // client_settings — privacy
  filenamePrivacyMode: PrivacyMode;
  filesizePrivacyMode: PrivacyMode;

  // client_settings — readiness / autoplay
  forceGuiPrompt: boolean;
  pauseOnLeave: boolean;
  readyAtStart: boolean;
  unpauseAction: UnpauseAction;
  autoplayInitialState: boolean | null;
  autoplayMinUsers: number;
  autoplayRequireSameFilenames: boolean;

  // client_settings — playlist
  sharedPlaylistEnabled: boolean;
  loopAtEndOfPlaylist: boolean;
  loopSingleFiles: boolean;
  onlySwitchToTrustedDomains: boolean;
  autosaveJoinsToList: boolean;
  trustedDomains: string[];
  publicServers: string[];

  // gui — kept for Syncplay compatibility; most have no effect in the TUI
  showOSD: boolean;
  showOSDWarnings: boolean;
  showSlowdownOSD: boolean;
  showDifferentRoomOSD: boolean;
  showSameRoomOSD: boolean;
  showNonControllerOSD: boolean;
  showContactInfo: boolean;
  showDurationNotification: boolean;
  chatInputEnabled: boolean;
  chatInputFontFamily: string;
  chatInputRelativeFontSize: number;
  chatInputFontWeight: number;
  chatInputFontUnderline: boolean;
  chatInputFontColor: string;
  chatInputPosition: ChatInputPosition;
  chatDirectInput: boolean;
  chatOutputEnabled: boolean;
  chatOutputFontFamily: string;
  chatOutputRelativeFontSize: number;
  chatOutputFontWeight: number;
  chatOutputFontUnderline: boolean;
  chatOutputMode: ChatOutputMode;
  chatMaxLines: number;
  chatTopMargin: number;
  chatLeftMargin: number;
  chatBottomMargin: number;
  chatMoveOSD: boolean;
  chatOSDMargin: number;
  notificationTimeout: number;
  alertTimeout: number;
  chatTimeout: number;

  // general
  language: string;
  checkForUpdatesAutomatically: boolean | null;
  lastCheckedForUpdates: string;

  // splatty-specific (stored in [splatty] section)
  playerKind: PlayerKind;
  setupComplete: boolean;
}

export type ConfigKey = keyof SplattyConfig;

export interface ConfigFieldMeta {
  key: ConfigKey;
  section: string;
  label: string;
  type:
    "string" | "number" | "boolean" | "string[]" | "record" | "privacy" | "unpause" | "playerKind";
}
