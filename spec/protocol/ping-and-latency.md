---
id: protocol-ping-latency
title: "Protocol: Ping, RTT & Forward-Delay Estimation"
tags: [protocol, ping, latency, rtt]
source: source/syncplay/protocols.py:809-838
related: ["[[../README]]", "[[message-reference]]", "[[state-sync-and-flow-control]]", "[[../client/sync-algorithm]]"]
---

# Protocol: Ping, RTT & Forward-Delay Estimation

## `PingService` (`protocols.py:809-837`)

A plain object (not a Twisted `Protocol`) — one instance held by each `SyncClientProtocol` and
each `SyncServerProtocol`. Both peers run the **identical algorithm** independently, feeding it
each other's self-reported numbers.

State: `_rtt` (last raw round-trip time), `_avrRtt` (EWMA of RTT), `_fd` (last computed forward
delay — an estimate of one-way message transit time).

### `newTimestamp()`
Returns `time.time()`. Used to stamp an outbound value that the peer is expected to echo back
unmodified later.

### `receiveMessage(timestamp, senderRtt)` (`protocols.py:819-831`)

Called whenever an incoming message carries a timestamp this side originally generated (now
echoed back):

1. If `timestamp` is falsy (0 or `None`) → no-op. This happens on the very first exchange,
   before either side has anything to echo yet.
2. `rtt = time.time() - timestamp` — elapsed time since *this side* stamped that value.
3. If `rtt < 0` or `senderRtt < 0` → abort with no state update at all (guards against clock
   skew or bogus data).
4. EWMA update: `avrRtt = avrRtt * 0.85 + rtt * 0.15` (`PING_MOVING_AVERAGE_WEIGHT = 0.85`,
   `constants.py:217`) — 85% weight on history. The very first sample seeds `avrRtt` directly
   (no history to blend with yet).
5. Forward-delay estimate:
   - if `senderRtt < rtt` (the peer's own measured RTT is smaller than what I measured) →
     `fd = avrRtt/2 + (rtt - senderRtt)` — an asymmetric correction accounting for the peer
     having a shorter round trip (e.g. because my own processing added latency on my end).
   - else → `fd = avrRtt/2` — assume the link is roughly symmetric, so half of the averaged RTT
     approximates one-way delay.

### `getLastForwardDelay()` → `_fd`
`getRtt()` → `_rtt` (the raw last value, echoed back out to the peer as `clientRtt`/`serverRtt`
so *they* can do their own asymmetric correction).

## Exchange sequence

**Client → server** `State.ping` (`protocols.py:304-308`):
```json
{
  "latencyCalculation": "<echoes the server's last-sent timestamp, unmodified>",
  "clientLatencyCalculation": "<new timestamp = time.time(), for the server to echo back later>",
  "clientRtt": "<pingService.getRtt() — client's last computed RTT>"
}
```

**Server → client** `State.ping` (`protocols.py:734-740`):
```json
{
  "latencyCalculation": "<new timestamp = time.time(), for the client to echo back>",
  "serverRtt": "<pingService.getRtt() — server's last computed RTT>",
  "clientLatencyCalculation": "<echoes the client's own last-sent timestamp, PLUS a processing-time correction, only if one was captured since the last send>"
}
```
The processing-time correction: `processingTime = time.time() - clientLatencyCalculationArrivalTime`
(time the server spent between receiving the client's stamp and now replying) is folded in so
the client's eventual RTT computation subtracts out server-side queueing delay. After being
echoed once, the server resets its stored `clientLatencyCalculation` to 0
(`protocols.py:739-740`) — it is only ever echoed once per received value.

## Client-side wiring (`_handleStatePing`, `protocols.py:262-270`)

1. Reads incoming `latencyCalculation` (server's new stamp) — stored to echo back next `State`.
2. If `clientLatencyCalculation` (echo of the client's own earlier stamp) + `serverRtt` are
   present → `pingService.receiveMessage(clientLatencyCalculation, serverRtt)`.
3. `messageAge = pingService.getLastForwardDelay()` is passed directly into
   `client.updateGlobalState(position, paused, doSeek, setBy, messageAge)`.

## Server-side wiring (`handleState`, `protocols.py:775-782`)

1. `latencyCalculation` = client's echo of the server's stamp (default 0).
2. `clientRtt` = client's self-reported RTT (default 0).
3. Server stores the client's *new* outbound stamp (`clientLatencyCalculation`) plus
   `clientLatencyCalculationArrivalTime = time.time()`, to echo (with correction) in the next
   send.
4. `pingService.receiveMessage(latencyCalculation, clientRtt)` updates the server's own RTT/FD.
5. If `serverIgnoringOnTheFly == 0`: `watcher.updateState(position, paused, doSeek,
   pingService.getLastForwardDelay())` — the server also compensates the position it stores by
   the estimated message age.

## Why this matters for sync accuracy

The estimated forward delay (`messageAge`) is added directly to the received position before
any threshold comparison in the client's sync algorithm:
```python
if not paused: position += messageAge
```
(`client.py:457-458`, see [`../client/sync-algorithm.md`](../client/sync-algorithm.md)) — this
means the authoritative position a client compares itself against is not the raw number in the
last `State` message, but that number advanced by however long the message is estimated to have
been in flight. A reimplementation that skips this compensation will systematically judge itself
"behind" on higher-latency connections, triggering spurious rewind/fast-forward corrections.

## Interaction with flow control

Per [`state-sync-and-flow-control.md`](state-sync-and-flow-control.md), the server withholds the
*entire* State message (ping block included) while `serverIgnoringOnTheFly != 0` — so RTT/FD
sampling pauses for roughly one round trip during any pending forced update. A reimplementation
should not treat a gap in ping samples during that window as a connectivity problem.
