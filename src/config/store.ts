import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import ini from "ini";
import type { SplattyConfig, ConfigKey, PlayerKind } from "./types.js";
import { defaultConfig } from "./defaults.js";
import { INI_STRUCTURE } from "./iniStructure.js";
import type { PrivacyMode } from "../protocol/constants.js";
import { DEFAULT_CLIENT_PORT, PUBLIC_SYNCPLAY_HOST } from "../protocol/constants.js";

const CONFIG_DIR_NAME = "splatty";
const CONFIG_FILE_NAME = "splatty.ini";

const SERIALISED_KEYS: ConfigKey[] = [
  "roomList",
  "perPlayerArguments",
  "mediaSearchDirectories",
  "trustedDomains",
  "publicServers",
];

const BOOLEAN_KEYS: ConfigKey[] = [
  "forceGuiPrompt",
  "pauseOnLeave",
  "readyAtStart",
  "autoplayRequireSameFilenames",
  "rewindOnDesync",
  "slowOnDesync",
  "fastforwardOnDesync",
  "dontSlowDownWithMe",
  "sharedPlaylistEnabled",
  "loopAtEndOfPlaylist",
  "loopSingleFiles",
  "onlySwitchToTrustedDomains",
  "autosaveJoinsToList",
  "showOSD",
  "showOSDWarnings",
  "showSlowdownOSD",
  "showDifferentRoomOSD",
  "showSameRoomOSD",
  "showNonControllerOSD",
  "showContactInfo",
  "showDurationNotification",
  "chatInputEnabled",
  "chatInputFontUnderline",
  "chatDirectInput",
  "chatMoveOSD",
  "chatOutputEnabled",
  "chatOutputFontUnderline",
  "setupComplete",
];

const TRISTATE_KEYS: ConfigKey[] = ["checkForUpdatesAutomatically", "autoplayInitialState"];

const NUMERIC_KEYS: ConfigKey[] = [
  "port",
  "slowdownThreshold",
  "rewindThreshold",
  "fastforwardThreshold",
  "folderSearchFirstFileTimeout",
  "folderSearchTimeout",
  "folderSearchDoubleCheckInterval",
  "folderSearchWarningThreshold",
  "autoplayMinUsers",
  "chatInputRelativeFontSize",
  "chatInputFontWeight",
  "chatOutputRelativeFontSize",
  "chatOutputFontWeight",
  "chatMaxLines",
  "chatTopMargin",
  "chatLeftMargin",
  "chatBottomMargin",
  "chatOSDMargin",
  "notificationTimeout",
  "alertTimeout",
  "chatTimeout",
];

export function getConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, CONFIG_DIR_NAME);
}

export function getConfigPath(): string {
  return join(getConfigDir(), CONFIG_FILE_NAME);
}

function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function serialiseValue(key: ConfigKey, value: unknown): string {
  if (SERIALISED_KEYS.includes(key)) return JSON.stringify(value).replace(/"/g, "'");
  if (TRISTATE_KEYS.includes(key)) {
    if (value === null || value === undefined) return "None";
    return String(value);
  }
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value ?? "");
}

function parseRawValue(key: ConfigKey, raw: string | undefined, fallback: unknown): unknown {
  if (raw === undefined || raw === "") return fallback;

  if (SERIALISED_KEYS.includes(key)) {
    try {
      const normalised = raw.replace(/'/g, '"');
      return JSON.parse(normalised);
    } catch {
      return fallback;
    }
  }

  if (BOOLEAN_KEYS.includes(key)) {
    if (raw === "True") return true;
    if (raw === "False") return false;
    return fallback;
  }

  if (TRISTATE_KEYS.includes(key)) {
    if (raw === "True") return true;
    if (raw === "False") return false;
    if (raw === "None") return null;
    return fallback;
  }

  if (NUMERIC_KEYS.includes(key)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  if (key === "playerKind") {
    const k = raw.toLowerCase();
    if (k === "mpv" || k === "vlc" || k === "null") return k as PlayerKind;
    return fallback;
  }

  if (key === "filenamePrivacyMode" || key === "filesizePrivacyMode") {
    if (raw === "SendRaw" || raw === "SendHashed" || raw === "DoNotSend") return raw as PrivacyMode;
    return fallback;
  }

  return raw;
}

function configToIni(config: SplattyConfig): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [section, keys] of Object.entries(INI_STRUCTURE)) {
    out[section] = {};
    for (const key of keys) {
      out[section][key] = serialiseValue(key, config[key]);
    }
  }
  return out;
}

/** Parses only the keys actually present (non-empty) in a parsed ini document. */
function iniToPartial(parsed: Record<string, Record<string, string>>): Partial<SplattyConfig> {
  const out: Record<string, unknown> = {};
  for (const [section, keys] of Object.entries(INI_STRUCTURE)) {
    const sectionData = parsed[section] ?? {};
    for (const key of keys) {
      const raw = sectionData[key];
      if (raw === undefined || raw === "") continue;
      out[key] = parseRawValue(key, raw, undefined);
    }
  }
  return out as Partial<SplattyConfig>;
}

function iniToConfig(
  parsed: Record<string, Record<string, string>>,
  base: SplattyConfig,
): SplattyConfig {
  return { ...base, ...iniToPartial(parsed) };
}

export function loadConfig(defaultName?: string): SplattyConfig {
  const path = getConfigPath();
  if (!existsSync(path)) return defaultConfig(defaultName);

  try {
    const raw = ini.parse(readFileSync(path, "utf8"));
    return migratePublicServerConfig(iniToConfig(raw, defaultConfig(defaultName)));
  } catch {
    return defaultConfig(defaultName);
  }
}

/** syncplay.pl:8997 frequently resets connections; prefer 8998 for saved configs still on the old default. */
function migratePublicServerConfig(config: SplattyConfig): SplattyConfig {
  if (config.host.toLowerCase() === PUBLIC_SYNCPLAY_HOST && config.port === 8997) {
    return { ...config, port: DEFAULT_CLIENT_PORT };
  }
  return config;
}

/** Per-directory `.syncplay` config names, checked in this order (see ConfigurationGetter.CONFIG_NAMES). */
const DIRECTORY_CONFIG_NAMES = [".syncplay", "syncplay.ini"];

/**
 * Walks from the directory containing `filePath` up to the filesystem root, loading any
 * `.syncplay`/`syncplay.ini` file found along the way and merging root-to-leaf so the directory
 * closest to the file wins. See spec/config/resolution-and-precedence.md (~lines 31-49) —
 * these files apply at the *highest* precedence of all, above the global config file.
 */
export function loadDirectoryConfigChain(filePath: string): Partial<SplattyConfig> {
  const dirs: string[] = [];
  let dir = dirname(resolve(filePath));
  dirs.push(dir);
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    dirs.push(dir);
  }
  dirs.reverse(); // root-most directory first, leaf (closest to the file) last

  let merged: Partial<SplattyConfig> = {};
  for (const d of dirs) {
    for (const name of DIRECTORY_CONFIG_NAMES) {
      const candidate = join(d, name);
      if (!existsSync(candidate)) continue;
      try {
        const raw = ini.parse(readFileSync(candidate, "utf8"));
        merged = { ...merged, ...iniToPartial(raw) };
      } catch {
        /* ignore malformed per-directory config */
      }
      break; // only one config file per directory, `.syncplay` takes priority over `syncplay.ini`
    }
  }
  return merged;
}

export function saveConfig(config: SplattyConfig): void {
  ensureConfigDir();
  const path = getConfigPath();
  const data = configToIni(config);
  writeFileSync(path, ini.stringify(data), "utf8");
}

export function needsSetup(config: SplattyConfig): boolean {
  return !config.setupComplete || !config.name.trim() || !config.host.trim() || !config.room.trim();
}

export interface CliOverrides {
  host?: string;
  port?: number;
  name?: string;
  room?: string;
  password?: string;
  playerKind?: PlayerKind;
  playerPath?: string;
  forceSetup?: boolean;
  forceGuiPrompt?: boolean;
  language?: string;
}

export function mergeConfig(base: SplattyConfig, overrides: CliOverrides): SplattyConfig {
  const merged = { ...base };
  if (overrides.host) merged.host = overrides.host;
  if (overrides.port !== undefined) merged.port = overrides.port;
  if (overrides.name) merged.name = overrides.name;
  if (overrides.room) merged.room = overrides.room;
  if (overrides.password !== undefined) merged.password = overrides.password;
  if (overrides.playerKind) merged.playerKind = overrides.playerKind;
  if (overrides.playerPath) merged.playerPath = overrides.playerPath;
  if (overrides.forceGuiPrompt) merged.forceGuiPrompt = true;
  if (overrides.language) merged.language = overrides.language;
  return merged;
}

export function formatConfigValue(key: ConfigKey, value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.join(", ") : "(empty)";
  if (value === null || value === undefined) return "(none)";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
