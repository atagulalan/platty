---
id: players-mpv-family
title: "Players: mpv, mpv.net, IINA, Memento"
tags: [players, mpv, iina, memento, json-ipc, lua]
source: source/syncplay/players/mpv.py, mpvnet.py, iina.py, ipc_iina.py, memento.py
related: ["[[../README]]", "[[abstraction-and-selection]]", "[[../client/overview-and-state-machine]]", "[[../quirks-and-gotchas]]"]
---

# Players: mpv, mpv.net, IINA, Memento

All four share one implementation lineage: `mpvnet.py`, `iina.py`, and `memento.py` **subclass
`MpvPlayer`** (`mpv.py:19`) directly — they inherit its entire IPC/property/OSD/Lua-script
machinery and override only startup-arg quirks and version handling.

## mpv (`mpv.py`) — the reference implementation

### IPC mechanism — a hybrid

Two channels operate together, not one:

1. **JSON-IPC socket/named pipe** via the vendored `python_mpv_jsonipc` library
   (`syncplay/vendor/python_mpv_jsonipc/`). `MpvPlayer` sets `_playerIPCHandler = MPV`, connects
   over a Unix domain socket (POSIX: `getRuntimeDir()/mpv-socket`) or named pipe (Windows:
   `"syncplay-mpv-<rand48>"`). Used for `set_property`/`command()` calls **outbound** (e.g.
   `_setProperty` → `mpvpipe.command("set_property", ...)`).
2. **Log-line scraping** for most **inbound** state: mpv's `--term-playing-msg` option is set to
   emit a delimited block on file load:
   ```
   <SyncplayUpdateFile>ANS_filename=...ANS_length=...ANS_path=...</SyncplayUpdateFile>
   ```
   and a **bundled Lua script** (`syncplayintf.lua`, injected via `args["script"]`) implements a
   custom `<paused=..., pos=...>` status-line protocol plus `script-message-to syncplayintf ...`
   commands for chat/OSD/position-polling. `lineReceived` parses these via
   `MPLAYER_ANSWER_REGEX = r"^ANS_([a-zA-Z_-]+)=(.+)$|^(Exiting)\.\.\. \((.+)\)$"`.

So a reimplementation targeting mpv needs **both** a JSON-IPC client for outbound commands and a
log-parsing loop (or, more robustly, could route everything through JSON-IPC's `observe_property`
— the reference client's hybrid design is a historical artifact of predating full JSON-IPC
adoption, not a hard requirement).

### Play/pause
`setPaused(value)` → `_setProperty("pause", "yes"/"no")`, guarded against redundant sends.
Read via `script-message-to syncplayintf get_paused_and_position`, answered as a Lua status
line.

### Seek/position
`setPosition(value)` → `_setProperty('time-pos', value)`, guarded against clobbering a
just-reset position. **Position is extrapolated, not fresh-polled every check**:
`getCalculatedPosition()` tracks `lastMPVPositionUpdate`; if mpv hasn't answered within
`MPV_UNRESPONSIVE_THRESHOLD` (60s) the player is considered dead and dropped; if merely slow
(>`PLAYER_ASK_DELAY` = 0.1s), the position is estimated as `_position + elapsed`.

### File info
Parsed from the `term-playing-msg` block (`ANS_filename`, `ANS_length` — falling back through
`${=duration:${=length:0}}`, i.e. mpv property name `duration` → `length` → `0`, because
different mpv builds/streams expose total time under different property names or not at all —
`ANS_path`). A manual re-query fallback exists for `(unavailable)` answers.

### Startup args (`getStartupArgs`, `mpv.py:56-76`)
Builds a single **option dict** — `MPV_ARGS` (`force-window=yes, idle=yes, hr-seek=always,
keep-open=always, input-terminal=no, term-playing-msg=<...>, keep-open-pause=yes`) plus
`args["script"] = <path to syncplayintf.lua>` — then merges user-supplied CLI args (stripped of
leading `-`/`--`, split on `name=value`) into the **same dict**, so user args can override
Syncplay's own defaults by key. `run()` first executes `mpv --version` and **requires mpv ≥
0.23.0** (`MPV_NEW_VERSION`) and gates OSC-visibility support on ≥ 0.28.0 — too old → error and
`client.stop()`.

### Quirks to replicate
- `TERM` env var is deleted for the subprocess — escape sequences break the log-line parser.
- macOS: probes `youtube-dl`'s shebang to splice system Python's `sys.path` into the mpv
  subprocess env (youtube-dl needs system Python).
- Command send-queue with dedup/superseding (`MPV_SUPERSEDE_IF_DUPLICATE_COMMANDS`) — repeated
  `time-pos` sets or `loadfile` calls are collapsed rather than all sent.
- "Not ready to send" gating after `loadfile` until the Lua script signals
  `</SyncplayUpdateFile>`, with a hard timeout fallback (`MPV_MAX_NEWFILE_COOLDOWN_TIME`) in case
  that signal never arrives (e.g. load failure).
- Text sanitization (`_sanitizeText`) handles mpv's property-expansion special characters
  (`%`, `{`, `}`, quotes, backslashes), including a private-use substitute character for
  backslashes round-tripped through chat.

## mpv.net (`mpvnet.py`)

Subclasses `MpvPlayer` with **no IPC override** (mpv.net is a .NET wrapper around libmpv,
exposing the same JSON-IPC + log-scrape surface). Differences:
- `run()` **forces** `MPV_NEW_VERSION = True` and `MPV_OSC_VISIBILITY_CHANGE_VERSION = True`
  unconditionally — no `--version` probe like real mpv.
- Appends `MPV_NET_EXTRA_ARGS = {'auto-load-folder': 'no'}` — disables mpv.net's own
  folder-auto-load-playlist feature, which would otherwise fight Syncplay's playlist control.
- Path matching: `"mpvnet" in path`; expects `mpvnet.exe`.

## IINA (`iina.py`, `ipc_iina.py`)

Subclasses `MpvPlayer` (IINA is itself mpv-based). Differences:
- Custom IPC handler class `IINA(MPV)` — retries starting the process up to 3 times on
  `MPVError`.
- `IINAProcess(MPVProcess)` overrides startup: `iina-cli` (IINA's scriptable launcher binary,
  **not** the `.app` bundle directly — path is rewritten from
  `IINA.app/Contents/MacOS/IINA` to the sibling `iina-cli`) **returns immediately** after
  launching the real app, so readiness is detected by **polling for the IPC socket file's
  existence** every 0.1s for up to 10s, not by process exit.
- Startup args are a **flat dict with explicit boolean values** (`argValue = "yes"` for bare
  flags) rather than mpv's valueless-flag convention — the underlying option parser apparently
  needs this.
- Options are pushed via `set_property` calls **after** connecting rather than as CLI startup
  args (unlike mpv's `MPV_ARGS` passed at launch) — implying `iina-cli` doesn't support the same
  startup-arg injection; `syncplayintf.lua` is loaded at runtime via `load-script` instead of
  `--script=`.
- Property name uses an `mpv-` prefix for the IPC socket flag (`mpv-input-ipc-server=<socket>`)
  since `iina-cli` forwards `--mpv-*` flags to the embedded mpv core; always includes
  `--no-stdin` and a background-image path argument.
- `_onFileUpdate()` override suppresses file-info updates for `iina-bkg.png`, IINA's placeholder
  startup background image.
- Path matching: `"iina-cli" in path`.

## Memento (`memento.py`)

Subclasses `MpvPlayer`. `run()` is a **trivial pass-through** with no version-force flags and,
critically, **does not call `MpvPlayer.run()`'s version-checking body at all** — it directly
constructs `MementoPlayer(...)`, so **no version gate is applied whatsoever**; any Memento
version is trusted unconditionally. Startup args use `args["scripts"]` (**plural**) instead of
mpv's `args["script"]` (singular) to inject `syncplayintf.lua` — a deliberate naming divergence
for this particular mpv fork; easy to get wrong when porting mpv support to yet another mpv
derivative. Path matching: `"memento" in path`; expects `memento.exe`.

## Summary: what a new mpv-derived player integration needs to check

1. Does it expose a real mpv JSON-IPC socket, or only a subset (may need `iina-cli`-style
   readiness polling instead of assuming immediate availability)?
2. Is the script-injection option singular (`script`) or plural (`scripts`)? This is a one-word
   difference that silently breaks Lua injection if assumed wrong.
3. Can startup options be passed as CLI args, or must they be pushed via `set_property` after
   connecting (IINA's case)?
4. Should version be actively probed (mpv's approach), force-assumed current (mpv.net/IINA), or
   skipped (Memento)? Getting this wrong risks silent misbehavior on features gated by mpv
   version thresholds (e.g. `MPV_OSC_VISIBILITY_CHANGE_VERSION`, added in mpv 0.28).
