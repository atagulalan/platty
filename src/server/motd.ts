// MOTD templating. See ../../../spec/server/overview-and-cli.md#motd.
// ASCII-art rendering is a *client* rendering concern (monospace + nbsp substitution) - the
// server only ever needs to pass the raw string through.

import { readFileSync } from "node:fs";
import { RECENT_CLIENT_THRESHOLD, SERVER_MAX_TEMPLATE_LENGTH, WARN_OLD_CLIENTS } from "../protocol/constants.js";
import { meetsMinVersion } from "../protocol/version.js";

export interface MotdContext {
  version: string;
  userIp: string;
  username: string;
  room: string;
  [key: string]: string;
}

/** Python's string.Template uses $var / ${var}; replicate that substitution syntax exactly. */
function substituteTemplate(template: string, ctx: Record<string, string>): string | null {
  let ok = true;
  const result = template.replace(/\$\{(\w+)\}|\$(\w+)/g, (whole, braced, bare) => {
    const key = braced ?? bare;
    if (!(key in ctx)) {
      ok = false;
      return whole;
    }
    return ctx[key]!;
  });
  return ok ? result : null;
}

export function loadMotdFile(path: string): string {
  // BOM-stripping utf-8 read, matching codecs.open(path, "r", "utf-8-sig")
  const raw = readFileSync(path, "utf8");
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/** "You are using Syncplay {} but a newer version is available" (messages_en.py), adapted. */
function oldClientWarning(clientVersion: string): string {
  return `You are using Syncplay/Platty ${clientVersion}, but a newer version may be available.`;
}

/**
 * Full MOTD composition for a connecting client, mirroring the reference server's `getMotd`
 * (server.py:104-123) exactly, including edge-case ordering:
 *  - No template configured: "" normally, or just the old-client warning line if the client is
 *    old enough to warrant one (this fires *even with no --motd-file configured* - previously
 *    this rewrite returned "" unconditionally in that case, which was a gap).
 *  - Template configured and substitutes cleanly: old-client warning (if any) is prepended,
 *    *then* the combined length is checked against SERVER_MAX_TEMPLATE_LENGTH.
 *  - Template configured but has an unescaped/unknown placeholder: the placeholder error string
 *    wins outright (no warning prepended) - matches the reference's try/except structure, where
 *    the warning is only added on the success path.
 */
export function renderMotdFor(template: string | null, ctx: MotdContext, clientVersion: string): string {
  const oldClient = WARN_OLD_CLIENTS && !meetsMinVersion(clientVersion, RECENT_CLIENT_THRESHOLD);

  if (!template) {
    return oldClient ? oldClientWarning(clientVersion) : "";
  }

  const substituted = substituteTemplate(template, ctx);
  if (substituted === null) return "[server MOTD template has unescaped/unknown placeholders]";

  const motd = oldClient ? `${oldClientWarning(clientVersion)}\n${substituted}` : substituted;
  return motd.length > SERVER_MAX_TEMPLATE_LENGTH ? "[server MOTD exceeds max length]" : motd;
}
