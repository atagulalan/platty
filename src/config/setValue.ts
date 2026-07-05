import type { ConfigKey, PlattyConfig, PlayerKind } from "./types.js";
import { CONFIG_ALIASES, CONFIG_FIELDS } from "./iniStructure.js";
import type { PrivacyMode } from "../protocol/constants.js";

export interface SetResult {
  ok: boolean;
  message: string;
  reconnect?: boolean;
}

function fieldMeta(key: ConfigKey) {
  return CONFIG_FIELDS.find((f) => f.key === key);
}

function parseStringList(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseRecord(raw: string): Record<string, string> | null {
  if (!raw.trim()) return {};
  try {
    const normalised = raw.replace(/'/g, '"');
    const parsed: unknown = JSON.parse(normalised);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

function parseBoolean(raw: string): boolean | null {
  const v = raw.toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  if (v === "none" || v === "null") return null;
  return null;
}

const CONNECTION_KEYS: ConfigKey[] = ["name", "host", "port", "password", "room", "playerPath", "playerKind"];

export function setConfigValue(config: PlattyConfig, rawKey: string, rawValue: string): SetResult {
  const key = CONFIG_ALIASES[rawKey.toLowerCase()];
  if (!key) {
    const known = Object.keys(CONFIG_ALIASES)
      .filter((k) => !k.includes("-"))
      .slice(0, 12)
      .join(", ");
    return { ok: false, message: `Unknown setting "${rawKey}". Try: ${known}, ...` };
  }

  const meta = fieldMeta(key);
  const prev = config[key];
  let next: unknown = rawValue;

  switch (meta?.type ?? typeof prev) {
    case "number":
      next = Number(rawValue);
      if (!Number.isFinite(next as number)) return { ok: false, message: `"${rawKey}" must be a number.` };
      break;
    case "boolean": {
      const b = parseBoolean(rawValue);
      if (b === null && key !== "autoplayInitialState" && key !== "checkForUpdatesAutomatically") {
        return { ok: false, message: `"${rawKey}" must be true/false.` };
      }
      next = b;
      break;
    }
    case "string[]":
      next = parseStringList(rawValue);
      break;
    case "record": {
      const parsed = parseRecord(rawValue);
      if (parsed === null) {
        return { ok: false, message: `"${rawKey}" must be a JSON object, e.g. {"mpv":"--fs"}.` };
      }
      next = parsed;
      break;
    }
    case "privacy":
      if (rawValue !== "SendRaw" && rawValue !== "SendHashed" && rawValue !== "DoNotSend") {
        return { ok: false, message: `"${rawKey}" must be SendRaw, SendHashed, or DoNotSend.` };
      }
      next = rawValue as PrivacyMode;
      break;
    case "playerKind": {
      const k = rawValue.toLowerCase();
      if (k !== "mpv" && k !== "vlc" && k !== "null" && k !== "mpvnet" && k !== "iina" && k !== "memento") {
        return { ok: false, message: `"${rawKey}" must be one of: mpv, vlc, null, mpvnet, iina, memento.` };
      }
      next = k as PlayerKind;
      if (k === "null") config.playerPath = "";
      else if (!config.playerPath || config.playerPath === "") config.playerPath = k;
      break;
    }
    case "unpause":
      if (!["IfAlreadyReady", "IfOthersReady", "IfMinUsersReady", "Always"].includes(rawValue)) {
        return { ok: false, message: `Invalid unpause action.` };
      }
      next = rawValue;
      break;
    default:
      next = rawValue;
  }

  (config as unknown as Record<string, unknown>)[key] = next;

  const reconnect = CONNECTION_KEYS.includes(key) && prev !== next;
  return {
    ok: true,
    message: `${key} = ${formatSetValue(next)}${reconnect ? " (reconnect to apply)" : ""}`,
    reconnect,
  };
}

function formatSetValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ") || "(empty)";
  if (value === null) return "(none)";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function listSettableKeys(): string[] {
  return [...new Set(Object.keys(CONFIG_ALIASES))].sort();
}
