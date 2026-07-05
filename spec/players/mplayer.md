---
id: players-mplayer
title: "Players: mplayer"
tags: [players, mplayer, slave-mode, stdin]
source: source/syncplay/players/mplayer.py
related: ["[[../README]]", "[[abstraction-and-selection]]", "[[mpv-family]]"]
---

# Players: mplayer

## IPC mechanism

Classic **mplayer "slave mode"** over the child process's stdin/stdout pipes
(`subprocess.Popen(..., stdin=PIPE, stdout=PIPE, stderr=STDOUT, bufsize=0)`). Commands are plain
text lines written to stdin; a listener thread reads stdout lines and dispatches to
`lineReceived`. Structurally near-identical to mpv's log-based half (mpv is a fork of mplayer2,
and this integration predates/parallels the mpv one) — the send-queue/dedup logic and text
sanitization (`_sanitizeText`, `_quoteArg`) are copy-pasted from `mpv.py` almost verbatim,
including reused mpv-named constants (`MPV_SUPERSEDE_IF_DUPLICATE_COMMANDS`) even in this file.

**Requires MPlayer2**, not the original MPlayer 1.x fork: the first stdout line is checked for
`"MPlayer 1"`, and if found, shows an `mplayer2-required` error and drops the connection.

## Play/pause — no absolute setter

Unlike every other player integration, mplayer **only exposes a toggle command** (`pause`), not
an absolute set. `setPaused(value)` doesn't set a property — it compares the desired value
against a **locally cached belief** (`self._paused`) and sends the toggle line only if they
differ, then optimistically flips its own cached belief. **If this cached belief ever diverges
from mplayer's real state** (e.g. a user manually presses pause inside the mplayer window, which
Syncplay has no way to detect, since there's no push notification for this), the two stay
silently out of sync until the next explicit state query. Status is read via
`get_property pause` → `ANS_pause=yes/no`.

## Seek/position

`setPosition(value)` sends `set_property time_pos <value>` **followed by a blocking
`time.sleep(0.03)`** — a hardcoded synchronization hack baked directly into the seek call,
presumably to let mplayer process the seek before any further command is sent. Position is read
via `get_property time_pos` → `ANS_time_pos=<value>`.

**No extrapolation** (`getCalculatedPosition`) like mpv/VLC — `askForStatus()` does a genuine
blocking round trip, waiting on a `threading.Event` **with no timeout** (unlike mpv's bounded
0.2s-ish wait), returning the freshly-received value directly.

## File info

`_onFileUpdate()` explicitly requests `filename`/`length`/`path` properties and **blocks
(unbounded `.wait()`)** until all three answer events fire, then calls `client.updateFile`
synchronously — not dispatched via `reactor.callFromThread` like mpv/VLC do, because this runs
early enough (at construction time) that the reactor-thread separation isn't yet a concern.

## Startup args (`getStartupArgs`)

Simpler than mpv's dict-merge approach — a **flat list**: user args first, then always-appended
`MPLAYER_SLAVE_ARGS = ['-slave', '--hr-seek=always', '-nomsgcolor', '-msglevel',
'all=1:global=4:cplayer=4', '-af-add', 'scaletempo']`. No companion scripting engine exists for
mplayer (unlike mpv's Lua script) — everything goes through the plain slave-mode
`get_property`/`set_property`/`pause`/`loadfile`/`quit` vocabulary, with OSD via
`osd_show_text "msg" duration level`.

## Quirks to replicate

- **Requires an initial file path to start** (`getPlayerPathErrors` enforces this) — mplayer's
  slave mode apparently can't be reliably launched without one.
- Same `TERM`-unset workaround and macOS `youtube-dl`/system-Python env-path splice as mpv (a
  copy-paste artifact — the comment in this file even still says "mpv" in places).
- **Non-ASCII file paths on Windows are not passed via the initial CLI argument** — stored as
  `delayedFilePath` and loaded post-startup via a slave `loadfile` command instead, because
  Windows argv encoding of the child process is unreliable for non-ASCII, whereas the slave-mode
  text channel can encode UTF-8 explicitly.

## Summary vs. mpv

| Aspect | mpv | mplayer |
|---|---|---|
| Pause | Absolute set via property | Toggle only, locally cached belief |
| Seek | Async, guarded against clobber | Sync + hardcoded 30ms sleep |
| Position polling | Bounded wait + extrapolation | Unbounded blocking wait, no extrapolation |
| Scripting | Bundled Lua script (`syncplayintf.lua`) | None — plain slave-mode vocabulary only |
| Version fork required | mpv ≥ 0.23.0 | MPlayer**2** specifically, not MPlayer 1.x |
