---
id: players-mpc
title: "Players: MPC-HC / MPC-BE"
tags: [players, mpc-hc, mpc-be, windows, copydata]
source: source/syncplay/players/mpc.py, mpcbe.py
related: ["[[../README]]", "[[abstraction-and-selection]]", "[[../client/overview-and-state-machine]]"]
---

# Players: MPC-HC / MPC-BE

Windows-only (requires `pywin32`; falls back to `DummyPlayer` on other platforms — see
[`abstraction-and-selection.md`](abstraction-and-selection.md)).

## IPC mechanism

MPC-HC/BE's built-in **"slave mode"** (originally designed for Media Portal integration),
transported over **`WM_COPYDATA` window messages**. `MpcHcApi` creates a hidden listener window
(class `'MPCApiListener'`) and registers a `WM_COPYDATA` handler. MPC-HC is launched via
`win32api.ShellExecute(0, "open", path, args, None, 1)` passing `<userArgs> /slave <hwnd>` — the
player is told the listener window's handle so it can send messages back. Commands/responses are
plain integer IDs defined as class constants (`CMD_OPENFILE`, `CMD_SETPOSITION`,
`CMD_PLAYPAUSE`, `CMD_NOWPLAYING`, `CMD_CURRENTPOSITION`, etc.) — **this is MPC's own fixed,
versioned slave-mode API**, not something Syncplay defines; a reimplementation targeting MPC-HC
must implement this exact command-ID protocol, which is externally documented by the MPC-HC
project itself, not by Syncplay.

## Play/pause

`pause()`/`unpause()`/`playPause()` send `CMD_PAUSE`/`CMD_PLAY`/`CMD_PLAYPAUSE`, gated by a
`@waitForFileStateReady` decorator that blocks until a `fileReady` event is set (MPC finished
loading, not in `MLS_CLOSING`/`LOADING`/`CLOSED` state) or raises `PlayerNotReadyException` after
`MPC_LOCK_WAIT_TIME`. State is read passively from cached `CMD_PLAYMODE` push notifications
(`isPaused()` just checks `playState != PS_PLAY`) — **no polling round-trip needed for state**,
unlike position (below).

**Version-specific inversion bug**: for MPC-HC version **exactly `1.6.4`**, the play/pause
boolean sense is inverted — a hardcoded single-version quirk table entry
(`__switchPauseCalls`).

## Seek/position

`seek(position)` sends `CMD_SETPOSITION`. Position reading is a genuine **request/response
round-trip**: `CMD_GETCURRENTPOSITION` → `CMD_CURRENTPOSITION` push, plus unsolicited
`CMD_NOTIFYSEEK` events (explicitly de-duplicated in code because "Notify seek is sometimes sent
twice" — a documented MPC quirk). **No log-scraping or extrapolation** like the mpv family or
VLC — MPC-HC pushes exact values synchronously on demand.

## File info

`CMD_NOWPLAYING`'s payload is a `|`-delimited string (with `|` escaped via a negative-lookbehind
regex); `value[3]` = filepath, `value[4]` = duration. The playing filename is derived by
splitting the filepath on `\\` — **Windows-path-specific**, not portable.

## Startup

`MPCHCAPIPlayer.run()` appends `/open`, `/new` to args, then launches via `ShellExecute` with
`"<args> /slave <hwnd>"`.

## Quirks to replicate

- **Version gating**: `askForVersion()`/`CMD_GETVERSION` is required on connect; if no reply
  within 0.1s, shows a version-insufficient error and stops the client
  (`constants.MPC_MIN_VER`).
- Background thread polls `win32gui.IsWindow(mpcHandle)` every 10s to detect MPC closing without
  a clean disconnect message.
- `setPaused`/`setPosition` wrapped in a `@retry(PlayerNotReadyException, MPC_MAX_RETRIES,
  MPC_RETRY_WAIT_TIME, 1)` decorator for transient not-ready states.
- **Play-state "refresh" workaround**: `_setPausedAccordinglyToServer`/`__forcePause`/
  `__refreshMpcPlayState` — force-pause, set desired pause state, and if MPC's actual state
  still doesn't match, toggle `playPause()` **twice** with a delay
  (`MPC_PAUSE_TOGGLE_DELAY`) — MPC-HC's play state can apparently get stuck/out-of-sync
  immediately after loading a new file, and this is the documented recovery.

## MPC-BE (`mpcbe.py`) — a thin subclass

`MPCBePlayer` subclasses `MPCHCAPIPlayer` directly and only overrides `run`, path
list/detection (`constants.MPC_BE_PATHS`, matching `mpc-be.exe`/`mpc-be64.exe`/
`mpc-beportable.exe`), icon path, and `getMinVersionErrorMessage`
(`constants.MPC_BE_MIN_VER`). **The entire `WM_COPYDATA` command-ID protocol is assumed
identical between MPC-HC and MPC-BE** — this confirms the two players deliberately kept wire
compatibility for this integration; a reimplementation supporting one gets the other almost for
free.

## Summary of MPC-family idiosyncrasies

| Behavior | Note |
|---|---|
| Play state read purely from cached push notifications | No polling round-trip for pause state, unlike position |
| `CMD_NOTIFYSEEK` sometimes fires twice | Explicit de-dup required |
| MPC-HC 1.6.4 inverts pause semantics | One hardcoded version exception |
| Play-state can get stuck after file load | "Double toggle" recovery workaround |
| Filepath split on `\\` | Windows-only string handling, not portable |
