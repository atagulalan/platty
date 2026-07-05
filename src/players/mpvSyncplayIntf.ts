// Helpers for mpv's bundled syncplayintf.lua overlay (mirrors source/syncplay/players/mpv.py and
// source/syncplay/constants.py MPV_SYNCPLAYINTF_* lists).

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

export const OSD_DURATION_S = 3.0;
export const OSD_WARNING_MESSAGE_DURATION_S = 5.0;
export const NO_ALERT_OSD_WARNING_DURATION_S = 13.0;

export const MPV_INPUT_PROMPT_START_CHARACTER = "〉";
export const MPV_INPUT_PROMPT_END_CHARACTER = " 〈";
export const MPV_INPUT_BACKSLASH_SUBSTITUTE_CHARACTER = "＼";

export type OsdType = "notification" | "alert" | "chat";
export type OsdMood = "neutral" | "bad" | "good";

/** Config fields forwarded to syncplayintf.lua via set_syncplayintf_options. */
export interface SyncplayIntfConfig {
  chatInputEnabled: boolean;
  chatInputFontFamily: string;
  chatInputRelativeFontSize: number;
  chatInputFontWeight: number;
  chatInputFontUnderline: boolean;
  chatInputFontColor: string;
  chatInputPosition: string;
  chatOutputFontFamily: string;
  chatOutputRelativeFontSize: number;
  chatOutputFontWeight: number;
  chatOutputFontUnderline: boolean;
  chatOutputMode: string;
  chatMaxLines: number;
  chatTopMargin: number;
  chatLeftMargin: number;
  chatBottomMargin: number;
  chatDirectInput: boolean;
  notificationTimeout: number;
  alertTimeout: number;
  chatTimeout: number;
  chatOutputEnabled: boolean;
  chatMoveOSD: boolean;
  chatOSDMargin: number;
  maxChatMessageLength: number;
  oscVisibilityChangeCompatible: boolean;
}

export function syncplayIntfScriptPath(): string {
  const candidates = [
    fileURLToPath(new URL("../../resources/syncplayintf.lua", import.meta.url)),
    fileURLToPath(new URL("../../../source/syncplay/resources/syncplayintf.lua", import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

/** Mirrors mpv.py _sanitizeText(). */
export function sanitizeMpvOsdText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/\n/g, "")
    .replace(/\\"/g, "<SYNCPLAY_QUOTE>")
    .replace(/"/g, "<SYNCPLAY_QUOTE>")
    .replace(/%/g, "%%")
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\\\{")
    .replace(/}/g, "\\\\}")
    .replace(/<SYNCPLAY_QUOTE>/g, '\\"');
}

export function buildSyncplayIntfOptionsString(config: SyncplayIntfConfig): string {
  const optionKeys: (keyof SyncplayIntfConfig)[] = [
    "chatInputEnabled",
    "chatInputFontFamily",
    "chatInputRelativeFontSize",
    "chatInputFontWeight",
    "chatInputFontUnderline",
    "chatInputFontColor",
    "chatInputPosition",
    "chatOutputFontFamily",
    "chatOutputRelativeFontSize",
    "chatOutputFontWeight",
    "chatOutputFontUnderline",
    "chatOutputMode",
    "chatMaxLines",
    "chatTopMargin",
    "chatLeftMargin",
    "chatBottomMargin",
    "chatDirectInput",
    "notificationTimeout",
    "alertTimeout",
    "chatTimeout",
    "chatOutputEnabled",
  ];
  const parts: string[] = [];
  for (const key of optionKeys) {
    parts.push(`${key}=${config[key]}`);
  }
  parts.push(`MaxChatMessageLength=${config.maxChatMessageLength}`);
  parts.push(`inputPromptStartCharacter=${MPV_INPUT_PROMPT_START_CHARACTER}`);
  parts.push(`inputPromptEndCharacter=${MPV_INPUT_PROMPT_END_CHARACTER}`);
  parts.push(`backslashSubstituteCharacter=${MPV_INPUT_BACKSLASH_SUBSTITUTE_CHARACTER}`);
  parts.push(`OscVisibilityChangeCompatible=${config.oscVisibilityChangeCompatible}`);
  return parts.join(", ");
}

export function osdScriptMessage(osdType: OsdType, mood: OsdMood): string {
  return `${osdType}-osd-${mood}`;
}

/** Undo mpv.py's backslash round-trip for chat lines scraped from mpv log output. */
export function restoreMpvChatBackslashes(text: string): string {
  return text.replaceAll(MPV_INPUT_BACKSLASH_SUBSTITUTE_CHARACTER, "\\");
}
