// URL detection and trusted-domain checks for automatic playlist file switching.
// See ../../../spec/client/playlist-and-readiness.md and source/syncplay/client.py:565-612.

const TRUSTABLE_WEB_PROTOCOLS = new Set(["http", "https"]);

export function isURL(path: string | null | undefined): boolean {
  return path != null && path.includes("://");
}

export interface TrustedDomainOptions {
  onlySwitchToTrustedDomains: boolean;
  trustedDomains: string[];
}

/** Whether an HTTP(S) URL may be opened automatically (shared playlist / file switch). */
export function isURITrusted(uri: string, options: TrustedDomainOptions): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }

  if (!TRUSTABLE_WEB_PROTOCOLS.has(parsed.protocol.replace(":", ""))) {
    return false;
  }
  if (!options.onlySwitchToTrustedDomains) {
    return true;
  }

  for (const entry of options.trustedDomains) {
    const slash = entry.indexOf("/");
    const trustedDomain = slash === -1 ? entry : entry.slice(0, slash);
    const pathPrefix = slash === -1 ? "" : entry.slice(slash + 1);

    let domainMatch = false;
    if (parsed.hostname === trustedDomain || parsed.hostname === `www.${trustedDomain}`) {
      domainMatch = true;
    } else if (trustedDomain.includes("*")) {
      const wildcardRegex = new RegExp(
        `^(${trustedDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, "([^.]+)")})$`,
        "i",
      );
      domainMatch = wildcardRegex.test(parsed.hostname);
    }
    if (!domainMatch) continue;

    if (pathPrefix && !parsed.pathname.startsWith(`/${pathPrefix}`)) {
      continue;
    }
    return true;
  }
  return false;
}

/** Strip configured media directories from a path, keeping bare filenames for the playlist. */
export function removeDirsFromPath(filePath: string): string {
  return filePath.split(/[/\\]/).pop() ?? filePath;
}
