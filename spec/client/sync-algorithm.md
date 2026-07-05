---
id: client-sync-algorithm
title: "Client: The Sync Algorithm"
tags: [client, sync, algorithm, thresholds]
source: source/syncplay/client.py:229-463, source/syncplay/constants.py:63-83
related: ["[[../README]]", "[[overview-and-state-machine]]", "[[../protocol/state-sync-and-flow-control]]", "[[../protocol/ping-and-latency]]", "[[../quirks-and-gotchas]]"]
---

# Client: The Sync Algorithm

This is the part of Syncplay most sensitive to exact replication — mismatched thresholds between
a reimplementation and the reference client will cause visible "fighting" (both sides repeatedly
correcting each other) in mixed-client rooms. All entry point: `_changePlayerStateAccordingToGlobalState()`
(`client.py:414-445`), called from `updateGlobalState()` (`client.py:452`) every time a `State`
message arrives.

## Inputs

- `diff = getPlayerPosition() - position` — positive means the local player is **ahead** of the
  authoritative position; negative means **behind**.
- `position` has already been advanced by the estimated network transit delay before this point:
  `if not paused: position += messageAge` (`client.py:457-458`, `messageAge` from
  [`../protocol/ping-and-latency.md`](../protocol/ping-and-latency.md)).
- Both `getPlayerPosition()` and `getGlobalPosition()` are wall-clock extrapolations, not fresh
  polls — see [`overview-and-state-machine.md`](overview-and-state-machine.md).

## Decision tree (in evaluation order)

1. **First-ever update**: if `_lastGlobalUpdate is None`, `_initPlayerState()` (`client.py:336`)
   seeks/pauses the player to match immediately, no thresholds — this is the initial sync on
   connect/room-join.

2. **Discrete seek** (`doSeek == True`): `_serverSeeked()` (`client.py:384`) — if
   `setBy != self.getUsername()` (not self-initiated), unconditionally jumps the player to
   `position` and shows a "X seeked from T1 to T2" notice. Self-initiated seeks are recognized
   and suppressed via the `ignoringOnTheFly` mechanism
   ([`../protocol/state-sync-and-flow-control.md`](../protocol/state-sync-and-flow-control.md)),
   not by comparing `setBy` alone.

3. **Rewind** (player too far ahead): if `diff > rewindThreshold` and not a `doSeek` and
   `rewindOnDesync` config is enabled → `_rewindPlayerDueToTimeDifference()` hard-seeks back to
   `position`.

4. **Fast-forward** (player too far behind): gated by `fastforwardOnDesync` **and**
   (`not currentUser.canControl()` **OR** `dontSlowDownWithMe == True`) — i.e. normally only
   non-controllers get auto-fast-forwarded:
   - Once `diff < -FASTFORWARD_BEHIND_THRESHOLD` (-1.75s) and not `doSeek`, a hysteresis timer
     (`behindFirstDetected`) starts.
   - Once sustained long enough (`durationBehind > fastforwardThreshold -
     FASTFORWARD_BEHIND_THRESHOLD`) **and** `diff < -fastforwardThreshold` →
     `_fastforwardPlayerDueToTimeDifference()` seeks to `position + FASTFORWARD_EXTRA_TIME`
     (0.25s **overshoot**, deliberate — not a bug), then sets a 3.0s refractory cooldown
     (`FASTFORWARD_RESET_THRESHOLD`) before it can trigger again.
   - If no longer behind by the margin, the hysteresis timer resets.

5. **Slowdown** (player slightly ahead, gentle correction instead of a hard seek): requires
   `player.speedSupported`, not `doSeek`, not paused, `slowOnDesync` enabled:
   - If `diff > slowdownThreshold` and not already slowed → `player.setSpeed(SLOWDOWN_RATE)`
     (0.95×).
   - Reset once `diff < SLOWDOWN_RESET_THRESHOLD` (0.1s) → `setSpeed(1.0)`.
   - Note the threshold ordering: `slowdownThreshold` (default 1.5, floor 1.3) is normally
     **lower** than `rewindThreshold` (default 4, floor 3) — slowdown is meant to catch mild
     drift gently before it grows large enough to trigger a hard rewind.

6. **Pause/unpause**: if `paused` differs from current global/player state →
   `_serverUnpaused()`/`_serverPaused()`. On pause, if `SYNC_ON_PAUSE` (default `True`) and the
   pause wasn't self-initiated, the player is also snapped to `getGlobalPosition()` **before**
   pausing — this is why other participants' subtitles/frame can visibly jump when someone else
   pauses.

## Numeric threshold reference

| Constant | Value | Config key (if user-adjustable) | Purpose |
|---|---|---|---|
| `SEEK_THRESHOLD` | 1s | — | Both player-diff and global-diff must exceed this to be classified a "seek" vs. drift |
| `DEFAULT_REWIND_THRESHOLD` / floor | 4 / 3 | `rewindThreshold` | Player-ahead hard-seek-back trigger |
| `DEFAULT_FASTFORWARD_THRESHOLD` / floor | 5 / 4 | `fastforwardThreshold` | Player-behind hard-seek-forward trigger |
| `FASTFORWARD_BEHIND_THRESHOLD` | 1.75s | — | Early-detection trigger to start the fast-forward hysteresis timer |
| `FASTFORWARD_EXTRA_TIME` | 0.25s | — | Deliberate overshoot added to the fast-forward seek target |
| `FASTFORWARD_RESET_THRESHOLD` | 3.0s | — | Cooldown after a fast-forward before it can re-trigger |
| `SLOWDOWN_RATE` | 0.95× | — | Playback speed while "slowed down" |
| `DEFAULT_SLOWDOWN_KICKIN_THRESHOLD` / floor | 1.5 / 1.3 | `slowdownThreshold` | Player-ahead gentle-correction trigger |
| `SLOWDOWN_RESET_THRESHOLD` | 0.1s | — | Diff below which speed reverts to 1.0 |
| `DIFFERENT_DURATION_THRESHOLD` | 2.5s | — | Used by file-duration matching, see [`privacy-and-file-matching.md`](privacy-and-file-matching.md) |
| `PROTOCOL_TIMEOUT` | 12.5s | — | Staleness threshold, shared with the server |

## "Never slow down or rewind others" (`dontSlowDownWithMe`)

Tooltip: *"Never slow down or rewind others (experimental)"*. Two distinct effects, both purely
local reporting/behavior tricks — nothing changes server-side:

1. In `getLocalState()` (`client.py:324-334`), the position this client **reports to the
   server** is substituted with `getGlobalPosition()` instead of the real `getPlayerPosition()`
   when this flag is on — i.e. **the client lies about its own position**, always claiming to be
   exactly where the group is, so no one else's client ever perceives it as "behind" and thus
   never rewinds/slows down for it.
2. In the fast-forward gate above, this flag additionally makes fast-forward-on-desync apply
   even to controllers (normally only non-controllers get auto-corrected) — since this client
   will never ask the room to wait for it, it must silently self-correct instead.

## Readiness coupling (cross-reference)

Pausing/unpausing is **not always a literal pause** — in managed rooms, a non-controller's
pause/unpause attempt gets converted into a readiness toggle instead of an actual state change.
Full detail: [`playlist-and-readiness.md#readiness-system`](playlist-and-readiness.md).

## Anti-oscillation mechanisms worth replicating exactly

- Fast-forward's 0.25s overshoot + 3s refractory cooldown (above) prevents rapid re-triggering
  right after a correction.
- **Rewind-to-zero double-check**: `establishRewindDoubleCheck()` (`client.py:208-213`) schedules
  re-checks at +0.5s/+1s/+1.5s that force another rewind-to-0 if the stored position crept back
  above 5s — a defensive workaround for players that don't reliably seek to exactly 0 on the
  first try. Side effect: any legitimate seek to a position >5s within ~1.5s of a rewind is
  silently ignored (`setPosition`, `client.py:825-830`: `if lastRewindTime... < 1.0 and position
  > 5: ignore`) — replicate this suppression window or users may see their own manual seeks
  right after a rewind get dropped.

## Related

- [`../protocol/state-sync-and-flow-control.md`](../protocol/state-sync-and-flow-control.md) —
  how self-initiated changes avoid being immediately re-applied from the echoed server state.
- [`../protocol/ping-and-latency.md`](../protocol/ping-and-latency.md) — where `messageAge`
  (used in step 0 of the position compensation) comes from.
