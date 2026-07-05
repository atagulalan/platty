---
id: client-playlist-readiness
title: "Client: Shared Playlist, Readiness & Auto-Play"
tags: [client, playlist, readiness, autoplay]
source: source/syncplay/client.py:956-1099,1790-2199
related: ["[[../README]]", "[[overview-and-state-machine]]", "[[sync-algorithm]]", "[[../server/playlist-and-persistence]]", "[[../config/ui-and-commands]]", "[[../quirks-and-gotchas]]"]
---

# Client: Shared Playlist, Readiness & Auto-Play

## Playlist model

`SyncplayPlaylist` (`client.py:1790-2199`) — see field reference in
[`../data-model.md`](../data-model.md). Holds bare filenames (directories stripped via
`removeDirsFromPath()` unless the entry is a URL), the current index, and undo buffers.

### Resolving a playlist entry to a local file (`FileSwitchManager.findFilepath`, `client.py:2313-2333`)

1. If the filename matches the currently-open file (`utils.sameFilename`), reuse its known path.
2. Otherwise scan `mediaFilesCache` (a `{directory: [files]}` map, background-refreshed by a
   `LoopingCall` walking `mediaSearchDirectories` every `FOLDER_SEARCH_DOUBLE_CHECK_INTERVAL`,
   default 30s) for an exact filename match.
3. Falls back to directly probing `os.path.join(directory, filename)` per configured
   `mediaDirectory` if the cache hasn't found it yet.

If resolution fails, `switchToNewPlaylistIndex()` shows `cannot-find-file-for-playlist-switch-error`
and does not advance. URL entries are checked against `isURITrusted()` (backed by the
`trustedDomains` config, default `["youtube.com", "youtu.be"]`) — untrusted URLs are rejected
with `cannot-add-unsafe-path-error` rather than opened. **This trust check is entirely
client-side** — the server has no concept of trusted domains (see
[`../server/playlist-and-persistence.md`](../server/playlist-and-persistence.md)).

### Local file open → playlist reconciliation

`client.updateFile()` calls `playlist.changeToPlaylistIndexFromFilename(filename)` every time a
file is opened in the player. If the opened filename matches a *different* playlist index than
current, the shared index is switched to match (opening a file locally re-syncs which playlist
item is "selected" for everyone in the room). If it matches the *same* index, it instead triggers
a rewind (treated as a manual re-open/loop, not a navigation).

### Propagation

All playlist mutations funnel through `SyncplayPlaylist.changePlaylist(files, username=None,
resetIndex=False)`:
- `username is None` (locally initiated) → if connected and shared-playlists are enabled, pushes
  via `Set.playlistChange`, then calls `changeToPlaylistIndex(newIndex)`.
- `username` set (remote-initiated, arrived via `Set.playlistChange` from another user) → just
  updates local state/UI with a "playlist changed by X" notice.

### Command → operation mapping (dispatched from the UI layer, see
[`../config/ui-and-commands.md`](../config/ui-and-commands.md) for the full slash-command table)

| Command | Operation |
|---|---|
| `/qa <file>` | `addFileToPlaylist()` → `changePlaylist()` |
| `/qas <file>` | sets `switchToNewPlaylistItem = True`, then re-dispatches as `/qa` |
| `/ql` | prints `_playlist` with current index starred |
| `/qs <n>` | `changeToPlaylistIndex(n, resetPosition=True)` + `rewindFile()` |
| `/qd <n>` | `deleteAtIndex(n)` → copies list, removes entry, `changePlaylist()` |
| `/qn` | `loadNextFileInPlaylist()` |
| `/u` | `undoPlaylistChange()` using the `_previousPlaylist` buffer |

## Readiness system

Per-user flag on `SyncplayUser.ready` (get/set via `isReady()`/`setReady()`), round-tripped via
`Set.ready` ([`../protocol/message-reference.md`](../protocol/message-reference.md)). Gated by
`@requireServerFeature("readiness")` (requires server ≥ 1.3.0).

### Pause is secretly a readiness toggle in managed rooms

`_toggleReady()` (`client.py:290-322`), invoked whenever a local pause-change is detected:

- **If the user can't control the room** (managed room, not a controller): the player is forced
  back to the current global pause state, and instead of pausing anyone, the user's own **ready
  flag** is toggled. Non-controllers in a managed room can never actually pause the shared
  stream — pressing pause only signals "I'm not ready."
- **Seamless music override**: if `isPlayingMusic() and _recentlyAdvanced()`, the toggle is
  suppressed entirely (prevents gapless music playlists from ping-ponging ready state on every
  track change).
- **Rewind-then-pause guard**: if the user just rewound and the room is globally paused and
  they haven't just auto-advanced, the pause is ignored (avoids misreading an auto-rewind-to-0 as
  "I paused").
- **Unpause without meeting conditions**: if `instaplayConditionsMet()` (below) says no, the
  player is forced back to paused, and the ready flag instead flips to `True` with a "ready to
  unpause" notice — i.e. a manual unpause attempt that doesn't meet the room's conditions is
  silently converted into "mark myself ready" rather than actually playing. This is a real UX
  surprise, not a bug, worth preserving faithfully or explaining clearly if changed.
- Otherwise: normal `changeReadyState(not paused)`.

### `instaplayConditionsMet()` (`client.py:1016-1031`)

Governs whether a manual unpause is allowed to play immediately, based on the `unpauseAction`
config:

| `unpauseAction` value | Condition to instaplay |
|---|---|
| `Always` | always |
| default (i.e. `isReady()` true) | user is already marked ready |
| `IfOthersReady` | `areAllOtherUsersInRoomReady()` |
| `IfMinUsersReady` | all others ready **and** room size ≥ `autoPlayThreshold` |

Playing a music file always instaplays regardless of the above.

### Auto-play-when-everyone-ready (`autoplayConditionsMet`, `client.py:1033-1042`)

Requires: currently paused, (`autoPlay` flag on **or** `recentlyAdvanced()`),
`currentUser.canControl()`, readiness feature supported,
`userlist.areAllUsersInRoomReady(requireSameFilenames=config)`, and either
`usersInRoomCount() >= autoPlayThreshold` **or** `recentlyAdvanced()`.

`_recentlyAdvanced()` is true for `AUTOPLAY_DELAY + 5` seconds (8s total) after a playlist
auto-advance — **during this window the room-size threshold is bypassed entirely**, so
auto-advancing to the next playlist item can auto-play with just 1 person in the room even if
the configured minimum is higher.

When conditions are met, `startAutoplayCountdown()` starts a 1-second `LoopingCall`
(`autoplayCountdown()`) counting down from `AUTOPLAY_DELAY = 3.0` seconds with an OSD countdown;
at 0, `client.setPaused(False)`. Re-checked (`autoplayCheck()`) from many event sources:
readiness changes, user-list changes, feature updates.

## Related

- [`sync-algorithm.md`](sync-algorithm.md) — how pause/unpause interacts with the position-sync
  decision tree once it *does* go through.
- [`../server/playlist-and-persistence.md`](../server/playlist-and-persistence.md) — what the
  server validates/stores for the playlist (much less than the client tracks).
