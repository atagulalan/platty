---
id: protocol-message-reference
title: "Protocol: Full Message Reference"
tags: [protocol, reference, schema]
source: source/syncplay/protocols.py
related: ["[[../README]]", "[[wire-format]]", "[[handshake-and-version-negotiation]]", "[[state-sync-and-flow-control]]", "[[ping-and-latency]]", "[[../data-model]]", "[[../quirks-and-gotchas]]"]
---

# Protocol: Full Message Reference

Exact schemas as consumed/produced by code (not idealized examples). See
[`wire-format.md`](wire-format.md) for the envelope/framing these are wrapped in.

## Hello

Version-field semantics are covered in depth in
[`handshake-and-version-negotiation.md`](handshake-and-version-negotiation.md) — this section
is the raw shape only.

**Client → Server** (`protocols.py:156-168`):
```json
{"Hello": {
  "username": "Bob",
  "password": "_md5hex_",
  "room": {"name": "SyncRoom"},
  "version": "1.2.255",
  "realversion": "1.7.6",
  "features": { "...": "client.getFeatures()" }
}}
```
`password` omitted if none configured; `room` omitted if not joining one.

**Server → Client** (`protocols.py:574-589`):
```json
{"Hello": {
  "username": "Bob",
  "room": {"name": "SyncRoom"},
  "version": "<echoes client's own version field>",
  "realversion": "1.7.6",
  "features": { "...": "server.getFeatures()" },
  "motd": ""
}}
```

Parsing (`_extractHelloArguments`): `username`/`room.name` are `.strip()`ped; `version`
preferentially reads `realversion` if present. Missing `username`/`roomName`/`version` →
`hello-server-error`. Password mismatch → `password-required-server-error` /
`wrong-password-server-error` (see [`handshake-and-version-negotiation.md`](handshake-and-version-negotiation.md)).

## Set

All shaped `{"Set": {"<subcommand>": {...}}}`; multiple subcommands may appear in one dict.

### `room`
Client → Server (`protocols.py:223-230`):
```json
{"Set": {"room": {"name": "NewRoom", "password": "optional"}}}
```
Routed to room-switch logic in [`../server/rooms-and-permissions.md`](../server/rooms-and-permissions.md).

### `user` (server → client only)
```json
{"Set": {"user": {
  "Bob": {
    "room": {"name": "SyncRoom"},
    "file": { "...": "or omitted" },
    "event": {"joined": true, "version": "1.7.6", "features": {}}
  }
}}}
```
`event.joined` → add user; `event.left` → remove user; neither present → plain field update
(room/file change without join/leave semantics). (`protocols.py:170-182,671-679`)

### `file`
Client → Server, sent alongside an immediate `sendList()` call (`protocols.py:232-234`):
```json
{"Set": {"file": {"name": "BigBuckBunny.avi", "duration": 596.458, "size": 220514438, "path": "..."}}}
```
`path` is **stripped before transmission** (`constants.PRIVATE_FILE_FIELDS = ["path"]`) — never
actually appears on the wire. `name`/`size` are subject to the three privacy modes described in
[`../client/privacy-and-file-matching.md`](../client/privacy-and-file-matching.md) *before* this
dict is even built. Server truncates `name` to `MAX_FILENAME_LENGTH` (250).

### `controllerAuth`
Client → Server (`protocols.py:320-326`): `{"Set": {"controllerAuth": {"room": "...", "password": "AB-123-456"}}}`
Server → Client (`protocols.py:627-634`): `{"Set": {"controllerAuth": {"user": "...", "room": "...", "success": true}}}`
Full auth logic: [`../server/rooms-and-permissions.md`](../server/rooms-and-permissions.md).

### `newControlledRoom` (server → client)
```json
{"Set": {"newControlledRoom": {"password": "AB-123-456", "roomName": "+Base:HASH12"}}}
```
Sent when a client tries to control a plain room that isn't yet in controlled form — the server
computes the canonical hashed name and returns it so the client can `Set.room` into it.

### `ready` (bidirectional)
Client → Server (`protocols.py:333-348`):
```json
{"Set": {"ready": {"isReady": true, "manuallyInitiated": true, "username": "optional-other-user"}}}
```
`username` present only when a *controller* is setting **someone else's** readiness (requires
the `setOthersReadiness` feature, server ≥ 1.7.2).
Server → Client (`protocols.py:636-653`):
```json
{"Set": {"ready": {"username": "Bob", "isReady": true, "manuallyInitiated": true, "setBy": "optional"}}}
```
Setting someone else's readiness also emits a synthetic Chat notification to clients that
*don't* declare the `setOthersReadiness` feature (clients that do declare it are expected to
render their own UI cue instead of a chat line).

### `playlistIndex` / `playlistChange`
See full client/server logic in [`../client/playlist-and-readiness.md`](../client/playlist-and-readiness.md)
and [`../server/playlist-and-persistence.md`](../server/playlist-and-persistence.md).
```json
{"Set": {"playlistIndex": {"index": 3}}}                          // client -> server
{"Set": {"playlistIndex": {"user": "Bob", "index": 3}}}            // server -> client
{"Set": {"playlistChange": {"files": ["a.mkv", "b.mkv"]}}}         // client -> server
{"Set": {"playlistChange": {"user": "Bob", "files": ["a.mkv"]}}}   // server -> client
```
Client tracks `hadFirstPlaylistIndex` per-connection: the *first* `playlistIndex` received after
connecting does not reset playback position; subsequent ones do. Resets on room change. Server
only applies index/playlist changes if `room.canControl(watcher)`; otherwise it re-sends the
watcher's own authoritative playlist/index back to correct them (silent revert, no error).

### `features` (bidirectional)
```json
{"Set": {"features": {"...": "..."}}}
```
Generic capability-flag exchange for post-1.5 peers. Server-side handling has a `# TODO: Check`
comment — no validation is performed on incoming feature claims.

## List

Client → Server request: `{"List": null}` (payload is JSON `null`; the server's handler ignores
it entirely).

Server → Client response (`protocols.py:707-717`):
```json
{"List": {
  "SyncRoom": {
    "Bob": {"position": 0, "file": {"...": "..."}, "controller": false, "isReady": true, "features": {}}
  }
}}
```
`position` is a **dead field, always literally `0`** — real position sync happens exclusively
via `State`. For empty *persistent* rooms, the server injects fake placeholder entries
(`_addDummyUserOnList`, `protocols.py:695-705`) so GUI clients can list empty rooms; the
placeholder "username" is a string of literal space characters, one extra space per dummy room
(`" " * dummyCount`) — trimming whitespace from usernames before dedup would collapse all
placeholders together. Only sent to clients whose `uiMode` feature indicates a GUI (unknown UI
mode defaults to being treated as GUI).

## State

The core sync + ping message. Full semantics: [`state-sync-and-flow-control.md`](state-sync-and-flow-control.md)
(the `ignoringOnTheFly` block) and [`ping-and-latency.md`](ping-and-latency.md) (the `ping`
block).

**Client → Server** (`protocols.py:294-318`):
```json
{"State": {
  "playstate": {"position": 123.45, "paused": false, "doSeek": false},
  "ping": {"latencyCalculation": 0, "clientLatencyCalculation": 0, "clientRtt": 0},
  "ignoringOnTheFly": {"server": 0, "client": 1}
}}
```
`playstate` omitted entirely if position/paused aren't both set, or if
`clientIgnoringOnTheFly != 0 AND serverIgnoringOnTheFly == 0`. `doSeek` omitted if falsy.
`ignoringOnTheFly` omitted entirely if both counters are zero.

**Server → Client** (`protocols.py:723-755`):
```json
{"State": {
  "ping": {"latencyCalculation": 0, "serverRtt": 0, "clientLatencyCalculation": 0},
  "playstate": {"position": 123.45, "paused": false, "doSeek": false, "setBy": "Bob"},
  "ignoringOnTheFly": {"server": 0, "client": 0}
}}
```
The entire message is withheld unless `serverIgnoringOnTheFly == 0 OR forced` — see
[`state-sync-and-flow-control.md`](state-sync-and-flow-control.md).

Both sides parse `playstate` defensively: missing `position` defaults to `0`; missing
`paused`/`doSeek`/`setBy` default to `None`.

## Chat

**Asymmetric schema by direction** — this is not a bug, it works only because neither side ever
needs to parse the shape it itself emits:

- Client → Server (`protocols.py:236-237`): payload is a **bare JSON string**:
  `{"Chat": "hello everyone"}`. Truncated client-side to `MAX_CHAT_MESSAGE_LENGTH` before send.
- Server → Client: payload is an **object**: `{"Chat": {"username": "Bob", "message": "hello everyone"}}`.

Server truncates to `maxChatMessageLength` (configurable), and drops the message entirely if
`--disable-chat` is set. Only forwarded to peers whose negotiated version meets
`CHAT_MIN_VERSION = "1.5.0"`.

## TLS

```json
{"TLS": {"startTLS": "send"}}   // client -> server, first message if TLS attempted
{"TLS": {"startTLS": "true"}}   // server -> client, upgrade proceeds
{"TLS": {"startTLS": "false"}}  // server -> client, upgrade declined
```
Full flow: [`handshake-and-version-negotiation.md`](handshake-and-version-negotiation.md).
Note: client matches these via substring containment (`"true" in answer`), not equality.

## Errors {#errors}

All server-triggered drops go through `dropWithError` → `{"Error": {"message": "<text>"}}` then
connection close. Client never sends `Error` to the server in normal operation (`sendError`
exists but has no call site found).

| Message key | Text (en) | Trigger |
|---|---|---|
| `unknown-command-server-error` | "Unknown command {}" | Top-level key isn't Hello/Set/List/State/Error/Chat/TLS |
| `not-json-server-error` | "Not a json encoded string {}" | `json.loads` failure |
| `line-decode-server-error` | "Not a utf-8 string" | Invalid UTF-8 bytes |
| `not-known-server-error` | "You must be known to server before sending this command" | Chat/Set/List/State before a successful Hello |
| `hello-server-error` | "Not enough Hello arguments" | Missing username/room/version in Hello (checked both directions) |
| `password-required-server-error` | "Password required" | Server requires a password, client omitted one |
| `wrong-password-server-error` | "Wrong password supplied" | Password hash mismatch |
| `client-drop-server-error` | "Client drop: {} -- {}" | Never sent to the client — logged to the server's own console on every `dropWithError` |

**No dedicated error exists** for oversized room names, usernames, chat messages, or playlists —
these are all silently truncated or reverted server-side rather than rejected with an `Error`.
See [`../server/playlist-and-persistence.md`](../server/playlist-and-persistence.md) and
[`../server/overview-and-cli.md`](../server/overview-and-cli.md) for the exact truncation
points.

Feature-gated client-local errors (never sent over the wire, shown directly in the UI from
local version checks): `not-supported-by-server-error`,
`shared-playlists-not-supported-by-server-error`, `shared-playlists-disabled-by-server-error`.
