// Numeric/behavioral constants extracted from the reference implementation.
// Every value here is cited in ../../spec/protocol/*.md and ../../spec/client/sync-algorithm.md
// Keep this file in sync with those specs - it is the single source of truth for tunables.

export const DEFAULT_PORT = 8999;

// syncplay-client CLI defaults when --host/--port are omitted - one of the reference public
// servers (syncplay.pl hosts five, on ports 8995-8999; see spec/README.md).
export const DEFAULT_CLIENT_HOST = "syncplay.pl";
export const DEFAULT_CLIENT_PORT = 8998;

/** Public syncplay.pl instances — see spec/README.md (ports 8995–8999). 8998 is preferred (8997 often resets). */
export const PUBLIC_SYNCPLAY_HOST = "syncplay.pl";
export const PUBLIC_SYNCPLAY_PORTS = [8998, 8996, 8995, 8997, 8999] as const;

export function nextPublicSyncplayPort(current: number): number | null {
  const ports = PUBLIC_SYNCPLAY_PORTS;
  const idx = ports.indexOf(current as (typeof ports)[number]);
  const next = ports[(idx + 1) % ports.length]!;
  return next === current ? null : next;
}

// spec/protocol/wire-format.md - Twisted LineReceiver defaults
export const LINE_DELIMITER = "\r\n";
export const MAX_LINE_LENGTH = 16384;

// spec/protocol/wire-format.md#idleliveness-timeout
export const PROTOCOL_TIMEOUT_MS = 12_500;
export const SERVER_STATE_INTERVAL_MS = 1_000;
export const PLAYER_ASK_DELAY_MS = 100;

// spec/protocol/handshake-and-version-negotiation.md - the permanent 1.2.255 compatibility hack
export const LEGACY_HELLO_VERSION = "1.2.255";
// Our own protocol *feature level*, sent as "realversion" - deliberately matches the reference
// implementation's version numbering (not this package's own semver!) so that meetsMinVersion()
// feature gates (chat >=1.5.0, setOthersReadiness >=1.7.2, ...) resolve to true against peers
// running this codebase, exactly as they would against a modern reference client/server.
export const REAL_VERSION = "1.7.6";

// spec/protocol/handshake-and-version-negotiation.md - feature min-version thresholds
export const MIN_VERSION = {
  controlledRooms: "1.3.0",
  userReadiness: "1.3.0",
  sharedPlaylists: "1.4.0",
  chat: "1.5.0",
  featureList: "1.5.0",
  setOthersReadiness: "1.7.2",
} as const;

export const RECENT_CLIENT_THRESHOLD = "1.7.5";
export const WARN_OLD_CLIENTS = true;

// spec/protocol/ping-and-latency.md
export const PING_MOVING_AVERAGE_WEIGHT = 0.85;

// spec/server/overview-and-cli.md - size/format guards
export const MAX_CHAT_MESSAGE_LENGTH = 150;
export const MAX_USERNAME_LENGTH = 16;
export const MAX_ROOM_NAME_LENGTH = 35;
export const MAX_FILENAME_LENGTH = 250;
export const PLAYLIST_MAX_ITEMS = 250;
export const PLAYLIST_MAX_CHARACTERS = 10_000;
export const SERVER_MAX_TEMPLATE_LENGTH = 10_000;
export const SERVER_STATS_SNAPSHOT_INTERVAL_MS = 3_600_000;
export const TLS_CERT_ROTATION_MAX_RETRIES = 10;

// spec/server/rooms-and-permissions.md
export const CONTROLLED_ROOM_REGEX = /^\+(.*):(\w{12})$/;
export const CONTROL_PASSWORD_REGEX = /^[A-Z]{2}-\d{3}-\d{3}$/;

// spec/client/sync-algorithm.md - numeric thresholds
export const SEEK_THRESHOLD_S = 1;
export const DEFAULT_REWIND_THRESHOLD_S = 4;
export const MINIMUM_REWIND_THRESHOLD_S = 3;
export const DEFAULT_FASTFORWARD_THRESHOLD_S = 5;
export const MINIMUM_FASTFORWARD_THRESHOLD_S = 4;
export const FASTFORWARD_BEHIND_THRESHOLD_S = 1.75;
export const FASTFORWARD_EXTRA_TIME_S = 0.25;
export const FASTFORWARD_RESET_THRESHOLD_S = 3.0;
export const SLOWDOWN_RATE = 0.95;
export const DEFAULT_SLOWDOWN_KICKIN_THRESHOLD_S = 1.5;
export const MINIMUM_SLOWDOWN_THRESHOLD_S = 1.3;
export const SLOWDOWN_RESET_THRESHOLD_S = 0.1;
export const DIFFERENT_DURATION_THRESHOLD_S = 2.5;
export const SYNC_ON_PAUSE = true;

// spec/client/reconnection-and-resilience.md
export const RECONNECT_MAX_RETRIES = 999;
export const CONNECT_TIMEOUT_MS = 10_000;
export function reconnectDelayMs(retries: number): number {
  return 100 * 2 ** Math.min(retries, 5); // capped at 3.2s
}

// spec/client/playlist-and-readiness.md
export const AUTOPLAY_DELAY_S = 3.0;
export const RECENTLY_ADVANCED_WINDOW_S = AUTOPLAY_DELAY_S + 5;
/** Mirrors source/syncplay/constants.py MUSIC_FORMATS (all lower case, with leading dot). */
export const MUSIC_FORMATS = [
  ".mp3",
  ".m4a",
  ".m4p",
  ".wav",
  ".aiff",
  ".r",
  ".ogg",
  ".flac",
] as const;
export const FOLDER_SEARCH_DOUBLE_CHECK_INTERVAL_MS = 30_000;

// spec/client/privacy-and-file-matching.md
export const PRIVACY_HIDDEN_FILENAME = "**Hidden filename**";
export const FILENAME_STRIP_REGEX = /[-~_.[\]():\s]/g;

export type PrivacyMode = "SendRaw" | "SendHashed" | "DoNotSend";
export const PRIVACY_SENDRAW: PrivacyMode = "SendRaw";
export const PRIVACY_SENDHASHED: PrivacyMode = "SendHashed";
export const PRIVACY_DONTSEND: PrivacyMode = "DoNotSend";
