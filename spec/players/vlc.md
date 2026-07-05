---
id: players-vlc
title: "Players: VLC"
tags: [players, vlc, lua, telnet]
source: source/syncplay/players/vlc.py
related: ["[[../README]]", "[[abstraction-and-selection]]", "[[../client/overview-and-state-machine]]"]
---

# Players: VLC

## IPC mechanism — a bundled Lua interface over plain-text TCP

Syncplay ships a `syncplay.lua` script (`findResourcePath("syncplay.lua")`) that it **copies
into VLC's user Lua interface directory** at launch (creating the directory if missing, chmod
0755 on POSIX). VLC is launched with `--extraintf=luaintf --lua-intf=syncplay
--lua-config=syncplay={modulepath="...",port="<random 10000-55000>"}`. Syncplay then connects
over **plain TCP to `127.0.0.1:<vlcport>`** using Twisted's `ReconnectingClientFactory`/
`LineReceiver` — a **line-based plaintext protocol**, not JSON, entirely separate from the
Syncplay-to-server wire protocol.

VLC's Lua interface search paths are hardcoded per platform: Linux `/usr/lib/vlc/lua/intf/`
(or the snap path if `'snap' in playerPath`), macOS
`/Applications/VLC.app/Contents/MacOS/share/lua/intf/`, BSD `/usr/local/lib/vlc/lua/intf/`,
Windows uses the exe's own directory + `/lua/intf/` (special-cased for `VLCPortable.exe`).

## Play/pause

`setPaused(value)` sends `set-playstate: paused|playing`. Incoming state parsed from
`playstate: <value>` lines, with a documented workaround for a **VLC EOF bug**: if position
hasn't moved across the last 3 polls and remaining time is under `VLC_EOF_DURATION_THRESHOLD`,
"playing" reports are reinterpreted as "paused."

## Seek/position

`setPosition(value)` sends `set-position: <value>`, with the float formatted using a
**locale-aware radix character** (detected via `"{:n}".format(1.5)`, replacing `.` with the
locale decimal separator) — needed because the Lua-side `tonumber()` parsing is locale-sensitive.
Reading position comes from `position: <value>` lines (with `,`→`.` normalization for the same
locale reason), with a second workaround for a **VLC time-precision bug**: duplicate position
values not at EOF are ignored rather than treated as fresh updates.
`getCalculatedPosition()` extrapolates elapsed time between polls, same philosophy as mpv (see
[`mpv-family.md`](mpv-family.md)); a separate "player latency" UI warning fires past
`VLC_LATENCY_ERROR_THRESHOLD`.

A hard version-specific guard: if `position < 0 and duration > 2147 and vlcVersion == "3.0.0"`,
the connection is dropped with a version-mismatch error — apparently VLC 3.0.0 had a 32-bit
integer overflow bug on long files (also see the `invalid-32-bit-value` duration sentinel check).

## File info — push, not poll

`_getFileInfo()` sends `get-duration`, `get-filepath`, `get-filename` on demand, but
`filepath-change-notification` and `duration-change` are **asynchronous push notifications**
that spawn `_onFileUpdate()` in a **new thread** — closer to event-driven than mpv/mplayer's
log-scraping poll loop. This means VLC's integration is a mix: some data is polled
client-side, some arrives unsolicited from the Lua script continuously.

## Startup args

`VLC_SLAVE_ARGS` (`constants.py:307-311`) = `['--extraintf=luaintf', '--lua-intf=syncplay',
'--no-quiet', '--no-input-fast-seek', '--play-and-pause', '--start-time=0']` plus OS-specific
extras (`--no-one-instance[-when-started-from-file]` by default;
`--verbose=2 --no-file-logging` on macOS). No separate version check happens before launch
(unlike mpv) — VLC's own reply to `get-vlc-version` (auto-sent on first `sendLine`) is checked
against `VLC_MIN_VERSION` only after a connection is established.

## Connection robustness

`ReconnectingClientFactory` with `initialDelay=0.3, maxDelay=0.45, maxRetries=50`, bounded by
`VLC_OPEN_MAX_WAIT_TIME` (20s since process launch) — VLC's Lua interface takes a moment to come
up after process start, so the client retries the local TCP connect rather than assuming it's
ready.

**OS-specific startup verification, because blocking-read behavior differs**:
- Linux/BSD (non-macOS): reads VLC's **stderr synchronously right after spawn**, watching for
  `[syncplay] Listening on host`/`Hosting Syncplay` success markers, or `Couldn't find lua
  interface`/`lua interface error` failure markers — *before* even attempting the TCP connect.
- macOS: instead spawns a **background thread** to watch for a lua-module-unload debug line that
  triggers `drop()`.

## URL/path handling

`getMRL()` manually builds `file://` URLs with backslash→slash conversion and percent-encoding —
not delegated to a library MRL builder.

## Summary of VLC-specific workarounds a reimplementation must decide whether to replicate

| Workaround | Why |
|---|---|
| Locale-aware radix character substitution | Lua `tonumber()` is locale-sensitive |
| 3-poll-stuck → "paused" reinterpretation | VLC EOF bug |
| Duplicate-position-value suppression | VLC time-precision bug |
| VLC 3.0.0 + duration > 2147 + negative position → hard drop | VLC 3.0.0 32-bit overflow bug |
| OS-specific stderr-vs-background-thread readiness detection | Blocking stderr reads behave differently across platforms |

These are all **VLC-version-specific bug workarounds**, not protocol requirements — a
reimplementation targeting only recent VLC releases may be able to drop some of them, but should
verify against the actual VLC version(s) it needs to support before assuming they're obsolete.
