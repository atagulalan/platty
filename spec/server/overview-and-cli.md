---
id: server-overview
title: "Server: Overview & CLI Reference"
tags: [server, cli, twisted, reactor]
source: source/syncplay/server.py, source/syncplay/ep_server.py
related: ["[[../README]]", "[[../architecture]]", "[[rooms-and-permissions]]", "[[playlist-and-persistence]]", "[[../protocol/wire-format]]", "[[../data-model]]"]
---

# Server: Overview & CLI Reference

## Class structure

`SyncFactory(Factory)` (`server.py:25`) — Twisted `Factory` subclass, the server-wide singleton
holding password, salt, feature flags, `RoomManager`, optional `StatsDBManager`, TLS context.
Its only Twisted hook:
```python
def buildProtocol(self, addr):
    return SyncServerProtocol(self)
```
Every TCP connection gets a fresh `SyncServerProtocol` (`protocols.py:452`, see
[`../protocol/wire-format.md`](../protocol/wire-format.md)).

## Reactor wiring (`ep_server.py:38-74`, not in `server.py`)

- One `SyncFactory` shared across all connections.
- Uses `TCP6ServerEndpoint`/`TCP4ServerEndpoint` (not the older `reactor.listenTCP`).
- **Dual-stack by default**: listens on both IPv6 and IPv4 endpoints on the same port
  independently, unless `--ipv4-only`/`--ipv6-only` restrict it; `--interface-ipv4`/
  `--interface-ipv6` bind a specific interface.
- Exits if both listen attempts fail.
- **No separate TLS listener** — TLS is negotiated in-band after plaintext accept (see
  [`../protocol/handshake-and-version-negotiation.md`](../protocol/handshake-and-version-negotiation.md)
  and the TLS section below).

## Data model

See [`../data-model.md`](../data-model.md) for `Room`/`ControlledRoom`/`Watcher`/`RoomManager`
field-by-field detail. Room/permission logic itself is in
[`rooms-and-permissions.md`](rooms-and-permissions.md).

## MOTD (`getMotd`, `server.py:104-123`)

- Reads `--motd-file` as UTF-8 with BOM-stripping (`codecs.open(path, "r", "utf-8-sig")`).
- Templated via Python's `string.Template` (`$variable`/`${variable}`), substituting `version`
  (server's own), `userIp`, `username`, `room`. Uses strict `.substitute()` — an unescaped `$`
  or unknown placeholder raises, caught and replaced with
  `server-messed-up-motd-unescaped-placeholders`.
- Capped at `SERVER_MAX_TEMPLATE_LENGTH = 10000` chars (`constants.py:321`); over the cap
  returns an error message instead of the MOTD.
- If `constants.WARN_OLD_CLIENTS` (default `True`) and the client doesn't meet
  `RECENT_CLIENT_THRESHOLD = "1.7.5"`, a "new syncplay available" notice is prepended/returned
  even with no MOTD file configured.
- **ASCII-art support is entirely client-side rendering**, not a server feature: the server just
  relays the raw MOTD string with embedded `\n`s. The Qt GUI client (`gui.py:545-563`)
  substitutes non-breaking spaces for literal spaces and wraps the text in `<code>` to force
  monospace, "to preserve the look of ASCII art." A reimplementing server only needs to pass the
  string through verbatim.

## Stats DB (`--stats-db-file`)

`StatsDBManager` (`server.py:358-377`) — single table:
```sql
CREATE TABLE IF NOT EXISTS clients_snapshots (snapshot_time INTEGER, version STRING)
```
Populated by `StatsRecorder` (`server.py:306-330`), a `LoopingCall` firing every
`SERVER_STATS_SNAPSHOT_INTERVAL = 3600`s (1 hour), first firing after `5*(port%10 + 1)` seconds
(staggers snapshot timing across servers on different ports to avoid a thundering herd). Each
tick inserts one row per currently-connected client: `(now, clientVersion)` — pure
version-adoption telemetry, **not per-event/per-user logging** (no usernames, no IPs, no room
names stored). Uses `twisted.enterprise.adbapi.ConnectionPool("sqlite3", path,
check_same_thread=False)`.

`RoomsRecorder` (`server.py:332-356`) is a byte-for-byte duplicate of `StatsRecorder` that is
**never instantiated anywhere** — dead code, safe to omit in a reimplementation.

Room/playlist persistence (`--rooms-db-file`) is a separate schema — see
[`playlist-and-persistence.md`](playlist-and-persistence.md).

## TLS setup (`--tls <cert-dir>`)

- Certs loaded from a **directory** containing exactly `privkey.pem`, `cert.pem`, `chain.pem`
  (`_allowTLSconnections`, `server.py:251-290`), via PyOpenSSL. `chain.pem` is split on the
  `-----BEGIN CERTIFICATE-----` sentinel to load a list of intermediate certs.
- Builds `twisted.internet.ssl.CertificateOptions` with a hardcoded cipher allowlist
  (ECDHE+ChaCha20/AES-GCM only) and pins minimum protocol to TLS 1.2 (falls back to explicit
  `TLSv1_2_METHOD` for older PyOpenSSL/Twisted).
- **No client certificate validation** — server never requests/checks a client cert.
- Cert hot-reload is checked lazily on the *next* incoming `TLS.startTLS=send`, not via a
  filesystem watcher (`checkLastEditCertTime` compares `cert.pem` mtime); capped at
  `TLS_CERT_ROTATION_MAX_RETRIES = 10` attempts.
- Full handshake flow: [`../protocol/handshake-and-version-negotiation.md`](../protocol/handshake-and-version-negotiation.md).

## Rate limiting / abuse protection

**There is essentially none.** No per-IP connection caps, no login-attempt throttling, no
message-rate limiting anywhere in `server.py`/`protocols.py`. What exists is size/format
truncation only:

| Guard | Value | Effect |
|---|---|---|
| Chat message length | `MAX_CHAT_MESSAGE_LENGTH` = 150 (`--max-chat-message-length`) | truncated, not rejected |
| Username length | `MAX_USERNAME_LENGTH` = 16 (`--max-username-length`) | truncated, then de-duplicated |
| Room name length | `MAX_ROOM_NAME_LENGTH` = 35 (constant, no flag) | truncated |
| Filename length | `MAX_FILENAME_LENGTH` = 250 (constant, no flag) | truncated |
| Playlist | 250 items / 10000 total chars | **entire playlist discarded**, room reverted for that sender only |
| MOTD template output | 10000 chars | error message substituted for MOTD |
| Idle liveness | `PROTOCOL_TIMEOUT` = 12.5s | force-disconnect (this is dead-peer detection, not abuse protection) |

Password auth has no attempt counting/backoff — a dropped connection can reconnect and retry
immediately, indefinitely. Password/hash comparisons use plain `!=`/`==`, not a timing-safe
compare. **A reimplementation intended for public/adversarial deployment should add connection
rate limiting and timing-safe comparisons — the reference implementation relies entirely on
external infrastructure (firewall/reverse proxy) for this.**

## Full CLI reference (`ep_server.py`)

| Flag | Type/default | Effect |
|---|---|---|
| `--port` | str; defaults to `DEFAULT_PORT` = 8999 | TCP4/TCP6 listen port |
| `--password` | str; env `SYNCPLAY_PASSWORD` | Shared password, MD5-hashed once at startup |
| `--isolate-rooms` | flag | Use `PublicRoomManager` — see [`rooms-and-permissions.md`](rooms-and-permissions.md) |
| `--disable-ready` | flag | `Watcher.isReady()` always returns `None` |
| `--disable-chat` | flag | Server silently ignores incoming Chat |
| `--salt` | str; env `SYNCPLAY_SALT`; random 10-uppercase-letter string if omitted (printed to stdout at startup) | Used in the controlled-room hash — **restarting without a fixed `--salt` invalidates all existing controlled-room links/passwords** |
| `--motd-file` | path | See MOTD section above |
| `--rooms-db-file` | path | Enables playlist persistence (SQLite) — [`playlist-and-persistence.md`](playlist-and-persistence.md) |
| `--permanent-rooms-file` | path (ignored if missing) | Newline-delimited room names that are never auto-deleted when empty; has no effect under `--isolate-rooms` |
| `--max-chat-message-length` | int, default 150 | |
| `--max-username-length` | int, default 16 | |
| `--stats-db-file` | path | Enables hourly version-snapshot logging |
| `--tls` | path (cert dir) | Enables STARTTLS |
| `--ipv4-only` / `--ipv6-only` | flag | Restrict to one stack |
| `--interface-ipv4` / `--interface-ipv6` | str, default `''` (all) | Bind address |

`SyncFactory.getFeatures()` (`server.py:89-102`) is what's actually sent to clients in the Hello
reply, encoding most of the above as capability flags: `isolateRooms`, `readiness`,
`managedRooms` (always `True`), `persistentRooms`, `chat`, `maxChatMessageLength`,
`maxUsernameLength`, `maxRoomNameLength` (constant 35), `maxFilenameLength` (constant 250),
`setOthersReadiness` (always `True`).

## Known dead/broken code (do not port)

- `RoomsRecorder` — exact duplicate of `StatsRecorder`, never instantiated.
- `SyncFactory.loadRoom()` (`server.py:76-77`) references `self._roomsDbHandle`, which doesn't
  exist on `SyncFactory` (it actually lives on `RoomManager`) — calling this method raises
  `AttributeError`. It is never called in practice.
