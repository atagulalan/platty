// Controlled ("managed") room naming/hash scheme. See
// ../../spec/server/rooms-and-permissions.md#password-format and #hash-computation.
//
// A controlled room's wire name is never the human-typed base name - it's a synthetic
// "+<baseName>:<12-hex-char-hash>" string, matched by CONTROLLED_ROOM_REGEX.
// This is a bespoke construction (not HMAC); replicated exactly for interop with the
// reference server/client's hashing.

import { createHash, randomInt } from "node:crypto";
import { CONTROLLED_ROOM_REGEX, CONTROL_PASSWORD_REGEX } from "./constants.js";

function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function sha1hex(input: string): string {
  return createHash("sha1").update(input, "utf8").digest("hex");
}

export function isControlledRoomName(roomName: string): boolean {
  return CONTROLLED_ROOM_REGEX.test(roomName);
}

export function parseControlledRoomName(
  roomName: string,
): { baseName: string; hash: string } | null {
  const m = CONTROLLED_ROOM_REGEX.exec(roomName);
  if (!m) return null;
  return { baseName: m[1]!, hash: m[2]! };
}

export function isValidControlPassword(password: string): boolean {
  return CONTROL_PASSWORD_REGEX.test(password);
}

/** salt -> SHA256(salt), folded twice into the final hash per the reference construction. */
export function computeRoomHash(baseName: string, password: string, salt: string): string {
  const saltHashed = sha256hex(salt);
  const provisional = sha256hex(baseName + saltHashed);
  return sha1hex(provisional + saltHashed + password)
    .slice(0, 12)
    .toUpperCase();
}

export function getControlledRoomName(baseName: string, password: string, salt: string): string {
  return `+${baseName}:${computeRoomHash(baseName, password, salt)}`;
}

export function checkControlPassword(roomName: string, password: string, salt: string): boolean {
  const parsed = parseControlledRoomName(roomName);
  if (!parsed) return false;
  if (!isValidControlPassword(password)) return false;
  return computeRoomHash(parsed.baseName, password, salt) === parsed.hash;
}

const UPPER_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";

function randomFrom(alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/** Format: AA-123-456 */
export function generateRoomPassword(): string {
  return `${randomFrom(UPPER_LETTERS, 2)}-${randomFrom(DIGITS, 3)}-${randomFrom(DIGITS, 3)}`;
}

/** 10 uppercase letters - used as the server's --salt when none is configured. */
export function generateServerSalt(): string {
  return randomFrom(UPPER_LETTERS, 10);
}
