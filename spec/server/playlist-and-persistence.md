---
id: server-playlist-persistence
title: "Server: Playlist Validation & Room Persistence"
tags: [server, playlist, persistence, sqlite]
source: source/syncplay/server.py, source/syncplay/utils.py
related: ["[[../README]]", "[[overview-and-cli]]", "[[rooms-and-permissions]]", "[[../client/playlist-and-readiness]]", "[[../protocol/message-reference]]"]
---

# Server: Playlist Validation & Room Persistence

## What the server stores

Just `Room._playlist` (a plain `list[str]` of filenames/URLs) and `Room._playlistIndex` (int or
`None`) — **no per-item metadata** (duration, size, etc. stay entirely client-local). The server
only relays raw strings and a position pointer; see
[`../client/playlist-and-readiness.md`](../client/playlist-and-readiness.md) for how the client
resolves these strings to actual local files.

## Incoming messages

`Set.playlistChange` / `Set.playlistIndex` — schemas in
[`../protocol/message-reference.md`](../protocol/message-reference.md). Dispatched to
`SyncFactory.setPlaylist()` / `setPlaylistIndex()` (`server.py:234-249`).

## Validation (`utils.playlistIsValid`, `utils.py:440-445`)

```python
def playlistIsValid(files):
    return len(files) <= PLAYLIST_MAX_ITEMS and sum(len(f) for f in files) <= PLAYLIST_MAX_CHARACTERS
```
`PLAYLIST_MAX_ITEMS = 250`, `PLAYLIST_MAX_CHARACTERS = 10000` (aggregate character length across
all filenames combined, `constants.py:84-85`). **This is the entire server-side validation** —
no URL/domain whitelist, no path/extension filtering. Trusted-domain lists
(`DEFAULT_TRUSTED_DOMAINS = ["youtube.com", "youtu.be"]`) and "whitelisted site" logic are purely
client-side (used by the GUI to decide whether to auto-fetch a URL) — the server has no
knowledge of them and will relay any string as a playlist entry.

On rejection, the server does **not** send an error — it simply re-pushes the room's
previously-valid playlist/index back to the offending sender only, silently reverting their
local state (`server.py:239-241,248-249`).

## Gating

Both `Room.setPlaylist`/`setPlaylistIndex` (ungated — anyone in a plain room can edit) and
`ControlledRoom`'s versions (gated by `canControl`, re-validating `playlistIsValid` itself) are
implemented. See [`rooms-and-permissions.md`](rooms-and-permissions.md) for the permission model.
On acceptance, the factory calls `room.writeToDb()` (below) and broadcasts the change to the
whole room.

## Persistence (`--rooms-db-file`)

`Room.writeToDb()` (`server.py:577-584`): if the room `isPersistent()` (has a DB handle, name
doesn't match the `-temp` exclusion) — if its playlist becomes empty, the row is deleted;
otherwise it's upserted as `(name, playlist-as-newline-joined-string, playlistIndex, position,
lastSavedUpdate)` via `RoomDBManager.saveRoom`.

**Storage format has no escaping**: the playlist is joined with `\n` into a single text column
(`getListAsMultilineString`/`convertMultilineStringToList`, `utils.py:432-437`) — a
filename/URL containing a literal newline character would corrupt the stored order on reload. A
reimplementation should either escape newlines or use a proper multi-row/JSON storage format
instead of replicating this.

Loaded back at startup by `RoomManager.loadRooms()` (`server.py:423-439`).

### Schema

```sql
-- rooms DB (--rooms-db-file)
CREATE TABLE IF NOT EXISTS persistent_rooms (
  name STRING PRIMARY KEY,
  playlist STRING,       -- newline-joined filenames, no escaping
  playlistIndex INTEGER,
  position REAL,
  lastSavedUpdate INTEGER
);

-- stats DB (--stats-db-file), unrelated schema, see server/overview-and-cli.md
CREATE TABLE IF NOT EXISTS clients_snapshots (
  snapshot_time INTEGER,
  version STRING
);
```

Both use `twisted.enterprise.adbapi.ConnectionPool("sqlite3", path, check_same_thread=False)`
for async access — this is a **per-process, single-file SQLite store**, not shared across
multiple server instances; horizontal scaling of the server is not supported by this design.

## GUI-visible side effect

When `--rooms-db-file` is active, the server flags `features["persistentRooms"] = True` and
sends extra `sendList(toGUIOnly=True)` broadcasts on join/leave/room-switch so GUI clients
refresh the empty-persistent-room placeholder entries (the dummy space-padded usernames described
in [`../protocol/message-reference.md#list`](../protocol/message-reference.md)).
