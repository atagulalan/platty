---
id: data-model
title: Data Model — Entity Reference
tags: [data-model, reference]
source: source/syncplay/server.py, source/syncplay/client.py, source/syncplay/protocols.py
related: ["[[README]]", "[[architecture]]", "[[server/rooms-and-permissions]]", "[[client/overview-and-state-machine]]", "[[protocol/message-reference]]"]
---

# Data Model — Entity Reference

Central reference for every in-memory entity referenced elsewhere in this spec. Server-side and
client-side models are independent (they don't share code), but represent the same logical
concepts.

## Server-side entities (`server.py`)

### `Room` (`server.py:535-673`)
Base room type — everyone can control playback.

| Field | Meaning |
|---|---|
| `_name` | room name string (or the synthetic `+name:HASH` form for controlled rooms) |
| `_watchers` | `dict[username -> Watcher]` |
| `_playState` | `STATE_PAUSED` (0) or `STATE_PLAYING` (1) |
| `_setBy` | last `Watcher` who set play state |
| `_playlist` | `list[str]` of filenames/URLs (no per-item metadata) |
| `_playlistIndex` | int or `None` |
| `_position` | float seconds |
| `_lastUpdate` / `_lastSavedUpdate` | timestamps |
| `_permanent` | bool — never auto-deleted when empty (from `--permanent-rooms-file`) |
| `_roomsDbHandle` | optional SQLite persistence handle |

`Room.getPosition()` (`server.py:597-608`) picks the authoritative position as
`min(self._watchers.values())`, using `Watcher.__lt__` to compare by position — i.e. **the
watcher furthest behind is the authority**, not "whoever spoke last." See
[`server/rooms-and-permissions.md`](server/rooms-and-permissions.md).

`Room.canControl(watcher)` always returns `True` (no gating).

### `ControlledRoom(Room)` (`server.py:675-722`)
Adds `_controllers: dict[username -> Watcher]`. `canControl(watcher)` checks
`watcher.getName() in self._controllers` — **identity is a bare username string**, not a
session token (see the security note in [`quirks-and-gotchas.md`](quirks-and-gotchas.md)).
`setPaused`/`setPosition`/`setPlaylist`/`setPlaylistIndex` all gate on `canControl` and silently
drop changes from non-controllers.

### `Watcher` (`server.py:725-888`)
Server-side façade around one connected client, created only after a successful Hello.

| Field | Meaning |
|---|---|
| `_connector` | the underlying `SyncServerProtocol` |
| `_name` | username (post-collision-resolution, see [`client/reconnection-and-resilience.md`](client/reconnection-and-resilience.md)) |
| `_room` | current `Room` |
| `_file` | dict: `name`, `duration`, `size` (privacy-scrubbed by the client before it ever reaches here) |
| `_position` | float seconds |
| `_ready` | tri-state: `None` (feature disabled/unset) / `True` / `False` |
| `_lastUpdatedOn` | timestamp, used for the 12.5s `PROTOCOL_TIMEOUT` liveness check |
| `_sendStateTimer` | per-watcher `LoopingCall`, fires every `SERVER_STATE_INTERVAL` (1s) |

`Watcher.__lt__` (`server.py:834-839`) sorts by position, with watchers lacking a file sorting
as "greater" (never picked as the position authority unless nobody has a file).
`Watcher.isController()` = `RoomPasswordProvider.isControlledRoom(roomName) and room.canControl(self)`.

### `RoomManager` / `PublicRoomManager` (`server.py:412-532`)
Plain `dict[name -> Room]`, no locking (safe only because Twisted's reactor is single-threaded).
`PublicRoomManager` (used under `--isolate-rooms`) overrides broadcast methods to scope
everything to a single room and drops rooms-DB/permanent-rooms support entirely (see
[`quirks-and-gotchas.md`](quirks-and-gotchas.md)).

### `SyncFactory` (`server.py:25`)
Twisted `Factory`; the true server-wide singleton — holds the hashed password, salt, feature
flags, `RoomManager`, and optional `StatsDBManager`/TLS context. See
[`server/overview-and-cli.md`](server/overview-and-cli.md).

## Client-side entities (`client.py`)

### `SyncplayClient` (`client.py:62`)
God-object; one instance per client process. Holds:
- Connection: `_protocol` (a `SyncClientProtocol`), `protocolFactory`, `_reconnectingService`,
  `serverVersion`, `serverFeatures` (dict of negotiated capability flags — see
  [`protocol/handshake-and-version-negotiation.md`](protocol/handshake-and-version-negotiation.md)).
- **Local** playstate (the actual player, as last polled): `_playerPosition`, `_playerPaused`,
  `_lastPlayerUpdate`.
- **Global** playstate (room-authoritative, as told by the server): `_globalPosition`,
  `_globalPaused`, `_lastGlobalUpdate`.
- `userlist` (a `SyncplayUserlist`), `playlist` (a `SyncplayPlaylist`), `fileSwitch` (a
  `FileSwitchManager`), `ui` (a `UiManager`).
- Sync tuning state: `_userOffset` ("Set Offset" value), `_speedChanged` (whether currently at
  `SLOWDOWN_RATE`), `behindFirstDetected` (fast-forward hysteresis timer), `autoPlay`/
  `autoPlayThreshold`/`autoplayTimer`.

Two independently wall-clock-extrapolated position readers:
- `getPlayerPosition()` (`client.py:483`) — local player position, extrapolated from
  `_lastPlayerUpdate` if playing.
- `getGlobalPosition()` (`client.py:506`) — room-authoritative position, extrapolated from
  `_lastGlobalUpdate` if not `_globalPaused`.

Both are described in depth in [`client/overview-and-state-machine.md`](client/overview-and-state-machine.md)
and consumed by [`client/sync-algorithm.md`](client/sync-algorithm.md).

### `SyncplayUser` (`client.py:1308`)
Per-user model: `username`, `room`, `file` (dict: name/duration/size/path — `path` is
client-local only, never sent), `ready`, `_controller`, `_features`.
`isFileSame(other)` compares via `utils.sameFilename`/`sameFilesize`/`sameFileduration` — see
[`client/privacy-and-file-matching.md`](client/privacy-and-file-matching.md).

### `SyncplayUserlist` (`client.py:1373`)
Room membership + readiness aggregation: `areAllUsersInRoomReady()`, `areAllFilesInRoomSame()`,
OSD-trigger bookkeeping.

### `SyncplayPlaylist` (`client.py:1790-2199`)
`_playlist` (list of bare filenames — `removeDirsFromPath()` strips directories unless the
entry is a URL), `_playlistIndex`, undo buffers `_previousPlaylist`/`_previousPlaylistRoom`. See
[`client/playlist-and-readiness.md`](client/playlist-and-readiness.md).

### `FileSwitchManager` (`client.py:2202`)
Background directory scanner: builds `{directory: [files]}` from `mediaSearchDirectories` on a
`LoopingCall` (default interval `FOLDER_SEARCH_DOUBLE_CHECK_INTERVAL` = 30s), used to resolve
playlist filenames to local paths.

## Wire-level playstate shape

Both server `Watcher` and client `SyncplayClient` ultimately serialize their state into the
`State` message's `playstate` object: `{position: float, paused: bool, doSeek: bool, setBy: str|null}`.
Full schema: [`protocol/message-reference.md#state`](protocol/message-reference.md).

## Entity correspondence table

| Concept | Server representation | Client representation |
|---|---|---|
| A connected participant | `Watcher` | `SyncplayUser` (one entry per user in `userlist`, including self) |
| A room | `Room` / `ControlledRoom` | no dedicated class — tracked as fields on `SyncplayUser`/`SyncplayClient` |
| The shared playlist | `Room._playlist` + `_playlistIndex` (bare list of strings, server-validated only for size) | `SyncplayPlaylist` (adds local path resolution, undo, URL trust-checking) |
| Current file info | `Watcher._file` (privacy-scrubbed dict as received) | `SyncplayUser.file` (dict incl. local `path`, never transmitted) |
| Authoritative position | `Room.getPosition()` = furthest-behind watcher | `SyncplayClient._globalPosition` (as told by server) |
