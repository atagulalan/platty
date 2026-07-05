// Filename/filesize privacy modes and the (metadata-only, not content-hash) file-matching
// heuristics. See ../../../spec/client/privacy-and-file-matching.md.
//
// There is no content/checksum hashing of media files anywhere - "same file" is judged purely
// from filename + filesize + duration. The SHA-256 hashing here is a privacy obfuscation
// feature, not a content-identity mechanism.

import { createHash } from "node:crypto";
import {
  DIFFERENT_DURATION_THRESHOLD_S,
  FILENAME_STRIP_REGEX,
  PRIVACY_DONTSEND,
  PRIVACY_HIDDEN_FILENAME,
  PRIVACY_SENDHASHED,
  type PrivacyMode,
} from "../protocol/constants.js";

function sha256hex12(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 12);
}

/** Reduce a URL to its last path segment, then strip punctuation the reference client ignores. */
export function stripFilename(filename: string, stripUrl = false): string {
  let name = filename;
  if (stripUrl) {
    try {
      const url = new URL(filename);
      name = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? filename);
    } catch {
      /* not a URL; fall through */
    }
  }
  return name.replace(FILENAME_STRIP_REGEX, "");
}

export function hashFilename(filename: string, stripUrl = false): string {
  return sha256hex12(stripFilename(filename, stripUrl));
}

export function hashFilesize(size: number): string {
  return sha256hex12(String(size));
}

/** Lets a raw value from one peer match a hashed value from a privacy-enabled peer. */
function sameHashed(raw1: string, hashed1: string, raw2: string, hashed2: string): boolean {
  return raw1 === raw2 || raw1 === hashed2 || hashed1 === raw2 || hashed1 === hashed2;
}

export function sameFilename(f1: string, f2: string): boolean {
  if (f1 === PRIVACY_HIDDEN_FILENAME || f2 === PRIVACY_HIDDEN_FILENAME) return true;
  const s1 = stripFilename(f1);
  const s2 = stripFilename(f2);
  return sameHashed(s1, hashFilename(f1), s2, hashFilename(f2));
}

export function sameFilesize(s1: number | string, s2: number | string): boolean {
  if (s1 === 0 || s2 === 0) return true; // 0 is the DoNotSend sentinel
  const raw1 = String(s1);
  const raw2 = String(s2);
  const hashed1 = typeof s1 === "number" ? hashFilesize(s1) : raw1;
  const hashed2 = typeof s2 === "number" ? hashFilesize(s2) : raw2;
  return sameHashed(raw1, hashed1, raw2, hashed2);
}

export function sameFileDuration(d1: number, d2: number, showDurationNotification = true): boolean {
  if (!showDurationNotification) return true;
  return Math.abs(Math.round(d1) - Math.round(d2)) < DIFFERENT_DURATION_THRESHOLD_S;
}

export interface PrivacySettings {
  filenameMode: PrivacyMode;
  filesizeMode: PrivacyMode;
}

/** Apply configured privacy transforms before a file's metadata is put on the wire. */
export function applyPrivacy(
  name: string,
  size: number,
  settings: PrivacySettings,
): { name: string; size: number | string } {
  const outName =
    settings.filenameMode === PRIVACY_DONTSEND
      ? PRIVACY_HIDDEN_FILENAME
      : settings.filenameMode === PRIVACY_SENDHASHED
        ? hashFilename(name)
        : name;
  const outSize: number | string =
    settings.filesizeMode === PRIVACY_DONTSEND
      ? 0
      : settings.filesizeMode === PRIVACY_SENDHASHED
        ? hashFilesize(size) // a 12-hex-char string, per the reference implementation
        : size;
  return { name: outName, size: outSize };
}
