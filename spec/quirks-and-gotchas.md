---
id: quirks-and-gotchas
title: Quirks & Gotchas Catalogue
tags: [quirks, gotchas, compatibility, security]
source: full-codebase reverse-engineering pass
related: ["[[README]]", "[[protocol/handshake-and-version-negotiation]]", "[[protocol/state-sync-and-flow-control]]", "[[server/rooms-and-permissions]]", "[[client/sync-algorithm]]", "[[config/resolution-and-precedence]]"]
---

# Quirks & Gotchas Catalogue

Concentrated list of every surprising, undocumented, or bug-adjacent behavior found while
reverse-engineering this codebase. A faithful wire-compatible reimplementation needs most of
these; a clean-room *inspired-by* reimplementation should treat this list as "things to
deliberately decide about," not silently inherit.

## Protocol-level

- **The Hello `version` field is a permanent, hard-coded lie.** Every client, including current
  releases, sends `"version": "1.2.255"` verbatim, with the true version only in `realversion`.
  The server does the mirror trick, echoing the client's own claimed `version` back as its own.
  Reading `version` instead of `realversion` will misidentify every peer.
  Detail: [`protocol/handshake-and-version-negotiation.md`](protocol/handshake-and-version-negotiation.md).
- **`ignoringOnTheFly` is bidirectional and asymmetric.** Both protocol objects track both a
  `client` and `server` counter. The `server` counter is acknowledged by exact-value match on
  both sides; the `client` counter is acknowledged by exact match **client-side** but
  **unconditionally overwritten, no check, server-side**. This asymmetry is load-bearing, not a
  bug. Detail: [`protocol/state-sync-and-flow-control.md`](protocol/state-sync-and-flow-control.md).
- **`PROTOCOL_TIMEOUT` is 12.5 seconds, not the "4 seconds" commonly quoted in public docs.**
- **`List`'s per-user `position` field is a dead stub, always `0`.** Real position sync happens
  exclusively via `State`.
- **Dummy/placeholder users for empty persistent rooms use runs of literal space characters as
  usernames** (`" " * dummyCount`) — a client that trims whitespace before dedup could collapse
  all placeholder rooms onto one entry.
- **Chat has an asymmetric wire schema by direction**: client→server is a bare JSON string;
  server→client is an object. Works only because neither side parses the shape it itself sends.
- **TLS `startTLS` answers are matched by substring containment (`"true" in answer`), not
  equality.**
- **The server password comparison implies the client must MD5-hash the password before
  sending** — it's compared directly against a pre-hashed value, so it's never true plaintext on
  the wire, but also never salted/challenged, so a captured hash is replayable indefinitely
  absent TLS.
- **Server withholds the entire `State` message (not just playstate) while
  `serverIgnoringOnTheFly != 0`** — ping/RTT sampling itself pauses during a pending forced
  update; don't mistake the resulting gap for a connectivity problem.

## Server-level

- **Position authority is "whoever is furthest behind,"** re-derived roughly every second from
  `min()` over connected watchers — not a single value "owned" by whoever last acted.
- **Controlled-room "controller" identity is a bare username string, not a session token.**
  Anyone who later connects and claims the same username in that room silently inherits
  controller status — a username-spoofing = privilege-escalation vector worth deliberately
  addressing (e.g. binding to a connection/session id) in any reimplementation meant for
  semi-trusted environments. Detail: [`server/rooms-and-permissions.md`](server/rooms-and-permissions.md).
- **Controlled-room auth success/failure is broadcast server-wide**, not room-scoped (unless
  `--isolate-rooms`), leaking which room-hash a user just authenticated into to every connected
  client anywhere on the server.
- **No rate limiting, connection throttling, or brute-force protection anywhere.** Sizes are
  truncated, not rejected; failed auth has no backoff. Treat the reference server as requiring
  external (firewall/reverse-proxy) protection for any public/adversarial deployment.
- **No timing-safe comparison** for password or controlled-room-hash checks.
- **`--isolate-rooms` silently drops `--rooms-db-file`/`--permanent-rooms-file` support** — both
  flags can be passed together with no error, but persistence does nothing under isolation.
- **`RoomsRecorder` is 100% dead code** (exact duplicate of `StatsRecorder`, never instantiated).
- **`SyncFactory.loadRoom()` is broken** — references a non-existent attribute, would raise
  `AttributeError`; never called in practice.
- **Persistent-room playlist storage has no newline escaping** — a filename/URL containing a
  literal `\n` would corrupt the stored order on reload.
- **The server is single-process/single-reactor with no locking and no shared external state
  store** (beyond optional per-process SQLite files) — horizontal scaling is not supported by
  this design.
- **TLS cert hot-reload is checked lazily on the next STARTTLS attempt**, not via a filesystem
  watcher — a rotated cert isn't picked up until some client next tries to negotiate TLS.

## Client-level

- **Pausing in a managed room, as a non-controller, is secretly a readiness toggle** — the
  player is forced back to the global state and only the user's own ready flag changes. Users
  experience this as "my pause got reverted," which is intended behavior, not a bug.
- **An unpause that doesn't meet `instaplayConditionsMet()` is silently converted into "mark
  myself ready"** rather than an error or a no-op.
- **"Never slow down or rewind others" makes the client lie about its own reported position** to
  the rest of the room — a pure client-side reporting trick, nothing changes server-side.
- **Rewind-to-zero has a built-in retry storm** (re-checks at +0.5/1/1.5s) that can suppress a
  legitimate manual seek to a position >5s if it happens within ~1 second of a rewind.
- **Fast-forward deliberately overshoots by 0.25s** and imposes a 3-second cooldown before it can
  re-trigger — not a bug, an anti-oscillation debounce.
- **Position tracking is wall-clock extrapolation, not continuous polling** — a `time.time()`
  jump (system clock change, VM pause/resume) produces transiently wrong computed positions
  until the next real update.
- **Playlist restoration after reconnect is inferred from a message pattern**, not an explicit
  protocol request — any other scenario producing an empty, no-username `playlistChange` while
  the internal flag happens to be set will also trigger a restore.
- **Username collision resolution ("fewest trailing underscores") is server-side**, not
  client-side, despite being framed as a client changelog entry.
- **No content-hashing of media files exists anywhere** — "same file" detection is pure
  filename+size+duration heuristics; the SHA-256 "hashing" that does exist is a privacy feature
  to obscure metadata, not a content-identity mechanism.
- **Auto-play's room-size threshold is bypassed entirely for ~8 seconds after a playlist
  auto-advance** — auto-play can fire with 1 person in the room in that window even if the
  configured minimum is higher.

## Player-integration level

- **No shared base implementation exists behind `BasePlayer`** — it's 100% abstract stubs;
  "support a new player" means copying the closest architectural sibling module, not extending a
  rich base class.
- **mpv-derived players disagree on a single option's cardinality**: mpv uses `script`
  (singular) to inject its Lua companion script; Memento uses `scripts` (plural). Easy to miss
  when porting to yet another mpv fork.
- **Version gating is inconsistent across the mpv family** — real mpv actively probes and
  refuses old versions; mpv.net/IINA force "new version" flags unconditionally; Memento skips
  version checking entirely (doesn't even call the shared check code path).
- **mplayer has no absolute pause setter**, only a toggle, tracked via a locally cached belief
  that can silently desync from the player's real state if the user pauses manually inside the
  player window.
- **MPC-HC version 1.6.4 specifically inverts play/pause boolean semantics** — one hardcoded
  version-exception in the codebase.
- **VLC 3.0.0 has a specific 32-bit overflow bug** triggering a hard connection drop under
  narrow conditions (`duration > 2147` + negative position) — version-specific, not general.
- **IINA's CLI (`iina-cli`) returns immediately after launch**, so readiness is detected by
  polling for the IPC socket file's existence, not by process exit or a fixed delay.

## Config/UI level

- **`forceGuiPrompt` defaults to `True`** — the settings dialog appears on every launch by
  default even with a fully valid config file, unless explicitly suppressed.
- **The `forceGuiPrompt`-triggers-dialog check compares against the string `"True"`, not a
  coerced boolean**, because it runs before ini-string-to-bool coercion happens elsewhere in the
  pipeline — fragile, but functionally correct given when it runs.
- **All numeric config values are coerced via blanket `float()`**, so integer-shaped settings
  like `chatMaxLines` round-trip as `7.0`.
- **A broken Qt install silently downgrades the client to console mode** rather than crashing
  (falls back to `noGui=True` after confirming the rest of the environment, e.g.
  `twisted.trial`, imports fine).
- **Closing the settings dialog via Escape or the X button calls `sys.exit()` directly** —
  cancelling config always terminates the whole process, even mid-retry after a validation
  error.
- **`COMMANDS_SETNOTREADY` contains a copy-paste bug** (`'setready'` instead of `'setnotready'`
  in its alias list) — mostly masked by `if/elif` branch ordering, but the long-form command
  doesn't work as named. Recommend fixing rather than replicating.
- **The `/`-prefix convention for chat-vs-command is GUI-only** — plain console mode has no such
  ambiguity and expects bare command words with no leading slash.
- **`-psn` is a hidden, undocumented argparse flag** that exists solely to swallow macOS's
  Launch-Services process-serial-number argument on double-click launches.
