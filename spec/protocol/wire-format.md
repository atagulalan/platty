---
id: protocol-wire-format
title: "Protocol: Wire Format & Framing"
tags: [protocol, wire-format, tcp, json]
source: source/syncplay/protocols.py:19-66
related: ["[[../README]]", "[[handshake-and-version-negotiation]]", "[[message-reference]]", "[[../quirks-and-gotchas]]"]
---

# Protocol: Wire Format & Framing

## Transport

Raw TCP (optionally upgraded to TLS in-band, see
[`handshake-and-version-negotiation.md`](handshake-and-version-negotiation.md) and
`server/overview-and-cli.md`), one message per line.

## Class hierarchy

```
twisted.protocols.basic.LineReceiver
  └── JSONCommandProtocol           (protocols.py:19)   — shared framing + dispatch
        ├── SyncClientProtocol      (protocols.py:70)   — client role
        └── SyncServerProtocol      (protocols.py:452)  — server role, one instance per socket
```

`JSONCommandProtocol` provides `handleMessages` (dispatch table), `lineReceived`
(decode/parse), `sendMessage` (encode/send), `drop`, and an abstract `dropWithError` that each
subclass overrides (client: shows UI error + stops reconnect service; server: logs locally,
sends an `Error` message, drops the connection).

## Framing

- **Delimiter**: Twisted `LineReceiver.delimiter` default, `b'\r\n'` — **never overridden** in
  this codebase, so it applies verbatim. `sendLine` = `transport.write(line + delimiter)`.
- **Max line length**: Twisted `LineReceiver.MAX_LENGTH` default, **16384 bytes** — never
  overridden. Exceeding it triggers Twisted's default `lineLengthExceeded()`, which is just
  `transport.loseConnection()` — **the connection drops silently, with no `Error` message sent**,
  because neither protocol class overrides this hook. A reimplementation that needs larger
  messages (e.g. huge playlists) must either raise this limit on both ends or ensure payloads
  stay well under it.

## `lineReceived` pipeline (`protocols.py:40-55`)

1. `line.decode('utf-8').strip()` — on `UnicodeDecodeError` →
   `dropWithError(getMessage("line-decode-server-error"))` ("Not a utf-8 string").
2. Empty line after strip → silently ignored, no error, no processing.
3. Debug-logged via `showDebugMessage` if enabled.
4. `json.loads(line)` — on `JSONDecodeError` →
   `dropWithError(getMessage("not-json-server-error").format(line))` ("Not a json encoded
   string {}").
5. Result passed to `handleMessages`.

## Message envelope

Every line is a JSON **object** whose top-level keys are command names:
`Hello`, `Set`, `List`, `State`, `Error`, `Chat`, `TLS`. `handleMessages`
(`protocols.py:20-38`) iterates `messages.items()` and dispatches each key to a `handleX`
method. Any other top-level key →
`dropWithError(getMessage("unknown-command-server-error").format(...))` (drops the connection;
source code has a `# TODO: log, not drop` comment suggesting this is stricter than intended).

Because dispatch is a loop over dict items, a single line could in principle carry multiple
top-level commands at once (e.g. `{"Hello": {...}, "Set": {...}}`), but every `sendMessage`
call in the actual codebase sends exactly one command per line. A reimplementation should
support parsing multiple commands per line for robustness, but never needs to emit them.

`sendMessage` (`protocols.py:57-60`): `json.dumps(dict_)` → UTF-8 encode → `sendLine`. No schema
validation library is used anywhere — every handler does ad-hoc `if "key" in dict` checks;
unknown extra keys in an otherwise-recognized message are silently ignored (forward-compatible
by omission, not by explicit versioned schema).

## Idle/liveness timeout

`PROTOCOL_TIMEOUT = 12.5` seconds (`constants.py:76`) — **not 4 seconds**, despite that figure
appearing in public-facing docs. Checked once per second (tied to the 1s
`SERVER_STATE_INTERVAL`):
- Server: if `time.time() - watcher._lastUpdatedOn > PROTOCOL_TIMEOUT`, the server force-drops
  that watcher (`server.py:857-862`).
- Client: same threshold used to locally judge the connection/sync as stale
  (`checkIfConnected`, `client.py:188-194`), dropping its own connection via `self._protocol.drop()`
  if exceeded.

**Heartbeat continues while paused — this is not optional.** The client's player-poll loop
(`scheduleAskPlayer`/`askPlayer`, `client.py:178-186`) is a Twisted `LoopingCall` firing every
`PLAYER_ASK_DELAY = 0.1s` (`constants.py:216`) **unconditionally**, regardless of the local or
global pause state — every tick calls `player.askForStatus()`, which flows through to a
`State` send (see [`ping-and-latency.md`](ping-and-latency.md)). A reimplementation that stops
emitting `State` messages while paused will be force-disconnected by the peer's
`PROTOCOL_TIMEOUT` after 12.5 idle seconds. Both a paused client and a paused server-side watcher
must keep exchanging `State` (with `playstate.paused: true`) at the normal cadence.

There is no other rate-limiting or flood protection at the wire level — see
[`../server/overview-and-cli.md`](../server/overview-and-cli.md) for what limits *do* exist
(all size/truncation caps, not connection-rate caps).

## Next

- [`handshake-and-version-negotiation.md`](handshake-and-version-negotiation.md) — what the
  first messages on a new connection look like
- [`message-reference.md`](message-reference.md) — full schema for every message type
