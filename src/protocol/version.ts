// Version comparison + the permanent "1.2.255" backward-compatibility hack.
// See ../../spec/protocol/handshake-and-version-negotiation.md.

import { LEGACY_HELLO_VERSION, MIN_VERSION, REAL_VERSION } from "./constants.js";

/**
 * Purely numeric dot-separated tuple comparison - no real support for "-beta"/"rc1" suffixes.
 * Non-numeric segments (e.g. a trailing "-ts" tag) coerce to 0 rather than NaN, so a suffix on
 * a later segment can't accidentally poison the comparison of earlier, purely-numeric segments.
 */
export function meetsMinVersion(version: string, minVersion: string): boolean {
  const toParts = (v: string): number[] => v.split(".").map((p) => Number(p) || 0);
  const a = toParts(version);
  const b = toParts(minVersion);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai !== bi) return ai > bi;
  }
  return true;
}

/**
 * What we put in Hello.version: always the fake legacy value, so ancient (1.2.x) peers that
 * only read this field treat us as compatible. Our true version travels in `realversion`.
 */
export function outgoingHelloVersion(): string {
  return LEGACY_HELLO_VERSION;
}

export function outgoingRealVersion(): string {
  return REAL_VERSION;
}

/** Prefer `realversion` (modern peers); fall back to `version` (ancient peers only send this). */
export function resolvePeerVersion(hello: { version: string; realversion?: string }): string {
  return hello.realversion ?? hello.version;
}

export interface FeatureFlags {
  managedRooms: boolean;
  readiness: boolean;
  sharedPlaylists: boolean;
  chat: boolean;
  featureList: boolean;
  setOthersReadiness: boolean;
}

/** Version-inferred feature defaults for a peer at the given (resolved) version. */
export function inferFeatures(peerVersion: string): FeatureFlags {
  return {
    managedRooms: meetsMinVersion(peerVersion, MIN_VERSION.controlledRooms),
    readiness: meetsMinVersion(peerVersion, MIN_VERSION.userReadiness),
    sharedPlaylists: meetsMinVersion(peerVersion, MIN_VERSION.sharedPlaylists),
    chat: meetsMinVersion(peerVersion, MIN_VERSION.chat),
    featureList: meetsMinVersion(peerVersion, MIN_VERSION.featureList),
    setOthersReadiness: meetsMinVersion(peerVersion, MIN_VERSION.setOthersReadiness),
  };
}
