---
id: players-abstraction
title: "Players: Abstraction Layer & Selection"
tags: [players, abstraction, architecture]
source: source/syncplay/players/basePlayer.py, source/syncplay/players/playerFactory.py, source/syncplay/players/__init__.py
related: ["[[../README]]", "[[../client/overview-and-state-machine]]", "[[mpv-family]]", "[[vlc]]", "[[mpc-hc-be]]", "[[mplayer]]", "[[../quirks-and-gotchas]]"]
---

# Players: Abstraction Layer & Selection

## `BasePlayer` — a pure interface, not a real base class

`BasePlayer` (`basePlayer.py:4-111`) is **100% abstract stubs** — every method body is
`raise NotImplementedError()`. There is essentially no shared implementation to inherit; each
concrete player reimplements everything independently, which is why mpv.py and mplayer.py
duplicate large near-identical blocks (sanitization, quoting, send-queue throttling) rather than
sharing a common helper.

**Interface methods** every player class provides:

| Method | Purpose |
|---|---|
| `askForStatus(self)` | Pull-based poll — must eventually call `client.updatePlayerStatus(paused, position)` |
| `displayMessage(self, message, duration, OSDType, mood)` | Show OSD/chat text in the player |
| `drop(self)` | Tear down IPC/process cleanly before exit |
| `run(client, playerPath, filePath, args)` (`@staticmethod`) | Factory entry point — launches the process, wires callbacks, eventually calls `client.initPlayer(instance)` |
| `setPaused(self, value: bool)` | Absolute pause/unpause (not all players support this as an absolute — see [`mplayer.md`](mplayer.md)) |
| `setFeatures(self, featureList: list)` | Push negotiated protocol features (meaningfully used only by mpv, to re-trigger Lua-script option updates) |
| `setPosition(self, value: float)` | Seek |
| `setSpeed(self, value: float)` | Playback rate |
| `openFile(self, filePath, resetPosition=False)` | Open/switch file |
| `getDefaultPlayerPathsList()` (`@staticmethod`) | Guessed install paths, for UI auto-detection |
| `isValidPlayerPath(path)` (`@staticmethod`) | Whether a given executable path belongs to this player |
| `getIconPath(path)` (`@staticmethod`) | UI icon |
| `getExpandedPath(path)` (`@staticmethod`) | Resolve a bare path/dir to the actual executable |
| `openCustomOpenDialog(self)` (`@staticmethod`) | Optional custom "open file" dialog hook (unused by all current players) |
| `getPlayerPathErrors(playerPath, filePath)` (`@staticmethod`) | Pre-flight validation (e.g. mplayer requires an initial file path) |

Capability flags (class attributes, not methods) read by client/UI code: `speedSupported`,
`alertOSDSupported`, `chatOSDSupported`, `customOpenDialog`, `osdMessageSeparator`.

`DummyPlayer(BasePlayer)` (`basePlayer.py:114-134`) is a no-op fallback used when a
platform-specific module fails to import (e.g. MPC-HC/BE need `pywin32`, Windows-only).

Callback contract back into `client.py` is documented in
[`../client/overview-and-state-machine.md#player-callback-contract`](../client/overview-and-state-machine.md).

## Player selection (`playerFactory.py`)

`PlayerFactory` does **not** launch anything itself (`BasePlayer.run()` does) — it's a lookup
helper over the class list from `players/__init__.py:getAvailablePlayers()`:
```
[MPCHCAPIPlayer, MpvPlayer, MpvnetPlayer, MementoPlayer, VlcPlayer, MpcBePlayer, MplayerPlayer, IinaPlayer]
```

Selection is **entirely string-matching on the executable path**, not a config enum —
`getPlayerByPath(path)` iterates this list calling each class's `isValidPlayerPath(path)`; first
match wins. Examples:

| Player | Match logic |
|---|---|
| mpv | `"mpv" in path and "mpvnet" not in path` |
| VLC | `"vlc" in path.lower()` |
| IINA | `"iina-cli" in path` |
| mplayer | `"mplayer" in path and "mplayerc.exe" not in path and "smplayer.exe" not in path` |
| MPC-HC / MPC-BE | no substring check — relies on `getExpandedPath` recognizing known executable filenames (`constants.MPC_EXECUTABLES`) since "mpc" alone isn't checked |

**Implication for adding a new player**: its path-matching substring must not collide with an
existing entry — this is *why* mpv explicitly excludes `mpvnet`, and mplayer explicitly excludes
MPC/SMPlayer executables that also happen to contain "mplayer"-like substrings. List **order**
also matters since the first match wins.

`getAvailablePlayerPaths()` aggregates every player's `getDefaultPlayerPathsList()` for UI
auto-detection; `getPlayerIconByPath`/`getExpandedPlayerPathByPath` follow the same
lookup-by-first-match pattern.

Import guarding (`players/__init__.py:7-21`): MPC-HC, MPC-BE, and IINA modules are wrapped in
`try/except ImportError`, falling back to `DummyPlayer` — MPC-HC/BE need `pywin32`
(Windows-only), IINA needs its own IPC module that may be unavailable on non-macOS builds.

## Cross-player architecture notes

- **No shared base implementation exists** — "add a new player" in practice means copying the
  closest architectural sibling (mpv-JSON-IPC-based → `mpvnet.py`/`iina.py`/`memento.py` all
  literally subclass `MpvPlayer`; VLC-telnet-based; MPC-COPYDATA-based; mplayer-stdin-based) and
  adapting it, not filling in template methods of a rich shared class.
- **Position-reporting philosophy differs sharply by player**: mpv/VLC/IINA/mpv.net/Memento
  extrapolate position between polls from a last-update timestamp (never trusting the last
  answer is still exactly current); MPC-HC and mplayer instead do a genuine blocking round-trip
  every single poll and just use the literal last answer, no extrapolation. See each player's
  own doc for specifics.
- **Push vs. poll is mixed even within one player** — e.g. VLC receives some updates purely by
  client-driven polling but also gets unsolicited push notifications on a separate thread. See
  [`vlc.md`](vlc.md).
- **Version gating is inconsistent across the mpv family** — real mpv actively probes and
  refuses to run below a minimum version; mpv.net and IINA force "new version" flags
  unconditionally (their wrapped mpv core version can't be queried the same way); Memento
  doesn't even go through the shared version-check code path. See [`mpv-family.md`](mpv-family.md).

## Per-player detail

- [`mpv-family.md`](mpv-family.md) — mpv, mpv.net, IINA, Memento (JSON-IPC + bundled Lua script)
- [`vlc.md`](vlc.md) — VLC's bundled Lua telnet interface
- [`mpc-hc-be.md`](mpc-hc-be.md) — Windows `WM_COPYDATA` slave-mode protocol
- [`mplayer.md`](mplayer.md) — stdin/stdout slave-mode protocol
