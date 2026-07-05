---
id: client-privacy-file-matching
title: "Client: Privacy Modes, File Matching & Set Offset"
tags: [client, privacy, hashing, offset]
source: source/syncplay/client.py:229-260,465-471,644-711,825-836, source/syncplay/utils.py:307-408
related: ["[[../README]]", "[[overview-and-state-machine]]", "[[sync-algorithm]]", "[[../protocol/message-reference]]", "[[../quirks-and-gotchas]]"]
---

# Client: Privacy Modes, File Matching & Set Offset

## Privacy modes for filename/filesize (`__executePrivacySettings`, `client.py:644-652`)

Two **independent** config keys — `filenamePrivacyMode` and `filesizePrivacyMode` — each one of:

| Mode | Constant | Effect |
|---|---|---|
| Send raw | `PRIVACY_SENDRAW_MODE = "SendRaw"` | value sent as-is |
| Send hashed | `PRIVACY_SENDHASHED_MODE = "SendHashed"` | value replaced by a truncated SHA-256 hash |
| Don't send | `PRIVACY_DONTSEND_MODE = "DoNotSend"` | filename → literal `"**Hidden filename**"` (`PRIVACY_HIDDENFILENAME`); size → `0` |

Because the two keys are independent, e.g. raw filename + hidden size is a valid combination.
`path` is **never** sent regardless of these settings — it's stripped unconditionally
(`constants.PRIVATE_FILE_FIELDS = ["path"]`) before the `Set.file` message is built. Full wire
shape: [`../protocol/message-reference.md#set`](../protocol/message-reference.md).

### Hashing (`utils.py`)

```python
def stripfilename(filename, stripURL=False):
    # URL-decode, optionally reduce to the last path segment, then strip
    # characters matching FILENAME_STRIP_REGEX = r"[-~_\.\[\](): ]"
    ...

def hashFilename(filename, stripURL=False):
    return sha256(stripfilename(filename, stripURL).encode()).hexdigest()[:12]

def hashFilesize(size):
    return sha256(str(size).encode()).hexdigest()[:12]
```
Stripping punctuation before hashing means filenames differing only in brackets/dashes/dots
still compare equal after stripping (relevant to matching, below) — but note hashing happens
*after* stripping, so `"My Movie (2020).mkv"` and `"My.Movie.2020.mkv"` hash identically.

## File-matching heuristics (not content hashing)

**There is no content/checksum hashing of the actual media file anywhere in the codebase.**
"Is this the same file as the other user's" is judged purely from metadata — filename + filesize
+ duration — and the SHA-256 "hashing" above is a **privacy obfuscation** feature, not a
content-identity mechanism. Two identically-named/sized/duration files that are actually
different content will report as "the same file"; a byte-identical file that's merely renamed
will report as different (unless filename privacy hides it entirely).

- `sameHashed(raw1, hashed1, raw2, hashed2)` (`utils.py:353-366`) — lets a raw value sent by one
  peer match a *hashed* value sent by a privacy-enabled peer, by checking all four combinations
  (raw==raw, raw==hash-of-other, etc.) — this is what makes cross-privacy-mode matching work at
  all.
- `sameFilename(f1, f2)` (`utils.py:369-384`) — special-cases the literal
  `"**Hidden filename**"` sentinel as **always matching** (so `DoNotSend` mode never produces a
  spurious "different file" warning), else delegates to `stripfilename` + `sameHashed`.
- `sameFilesize(s1, s2)` (`utils.py:387-393`) — size `0` (the `DoNotSend` sentinel) always
  matches, else `sameHashed`.
- `sameFileduration(d1, d2)` (`utils.py:396-402`) — if the "show duration notification" setting
  is off, always considered the same; else `abs(round(d1) - round(d2)) < DIFFERENT_DURATION_THRESHOLD`
  (2.5 seconds).

Duration itself comes from the media player (not extracted/probed by `client.py`/`utils.py`) —
fed in purely via `client.updateFile(filename, duration, path)` from the player integration
layer ([`../players/abstraction-and-selection.md`](../players/abstraction-and-selection.md)).

## "Set Offset"

A single float, `_userOffset` (`client.py:130`), get/set via `getUserOffset()`/`setUserOffset()`
(`client.py:465-471`):
```python
def setUserOffset(self, time):
    self._userOffset = time
    self.setPosition(self.getGlobalPosition())
    self.ui.showMessage(getMessage("current-offset-notification").format(self._userOffset))
```
Applied in exactly two places, in **opposite directions** — the offset is purely local/cosmetic
and is never transmitted to the server:

- **Outgoing** (`updatePlayerStatus`, `client.py:229-260`): the raw player position has
  `position -= getUserOffset()` applied **before** it's stored/compared/sent — what the server
  (and thus everyone else) sees is "my position minus my offset."
- **Incoming** (`setPosition`, `client.py:825-836` — the single choke point for seeking the real
  player to any room-clock position, used by rewind/fast-forward/pause-sync/seek-notification):
  `position += getUserOffset()` is applied **before** calling `player.setPosition(position)`.

Net effect: if your local file has, say, a 10-second-longer intro than the release the room is
synced to, setting `offset = -10` means: whenever reporting your position, 10 is subtracted (so
the group doesn't see you as artificially 10s ahead); whenever seeking your own player to a
group-clock position, 10 is subtracted again (shifting the target back into your file's local
timeline) — keeping the actual video content aligned despite the constant on-disk timestamp
difference.

UI entry points (console): `o +5`, `o -5` (relative adjust), `o /12.3` (set offset such that the
player's *current* position becomes exactly 12.3s of room time) — parsed by `UI_OFFSET_REGEX`
in `consoleUI.py`, see [`../config/ui-and-commands.md`](../config/ui-and-commands.md).
