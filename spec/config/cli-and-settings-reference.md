---
id: config-cli-settings-reference
title: "Config: CLI Arguments & Settings Schema"
tags: [config, cli, reference]
source: source/syncplay/ui/ConfigurationGetter.py
related: ["[[../README]]", "[[resolution-and-precedence]]", "[[ui-and-commands]]"]
---

# Config: CLI Arguments & Settings Schema

## Full CLI argument list (`getConfiguration`, lines 501-521, `argparse`)

| Flag(s) | dest → config key | Type/action | Notes |
|---|---|---|---|
| `--no-gui` | `noGui` | `store_true` | |
| `-a`, `--host` | `host` | str | **No `-h` short flag** — `-h` is argparse's own `--help`; host's short flag is `-a` |
| `-n`, `--name` | `name` | str | username |
| `-d`, `--debug` | `debug` | `store_true` | |
| `-g`, `--force-gui-prompt` | `forceGuiPrompt` | `store_true` | |
| `--no-store` | `noStore` | `store_true` | don't write `.syncplay`/ini |
| `-r`, `--room` | `room` | str, `nargs='?'` | legal with no value → `None` |
| `-p`, `--password` | `password` | str, `nargs='?'` | |
| `--player-path` | `playerPath` | str | |
| `-psn` | *(discarded)* | str, `argparse.SUPPRESS` | **undocumented/hidden** — absorbs macOS's Launch-Services `-psn_x_xxxxx` argument so double-clicking the `.app` doesn't crash argparse |
| `--language` | `language` | str | e.g. `de`/`en`/`tr` |
| `file` (positional) | `file` | str, `nargs='?'` | media file/URL |
| `--clear-gui-data` | `clearGUIData` | `store_true` | wipes QSettings (window state, path history) |
| `-v`, `--version` | — | `store_true` | prints version and `sys.exit()`s **immediately**, before any other config/GUI/ini processing |
| `--load-playlist-from-file` | `loadPlaylistFromFile` | str | one entry per line |
| `_args` (positional, catch-all) | `playerArgs` | str, `nargs='*'` | extra player CLI args; prefix with a bare `--` if they start with `-` |

**Quirk**: if the positional `file` argument accidentally starts with `--` (player args placed
before the file), the code detects `config['file'][:2] == "--"` and reclassifies it into
`playerArgs`, clearing `file`.

## Full config key schema

| Key | Default | Notes |
|---|---|---|
| `host` | `None` | split into host/port during validation (`_splitPortAndHost`, handles `[ipv6]:port`) |
| `port` | `DEFAULT_PORT` (8999) | |
| `name` | `None` | |
| `debug` | `False` | |
| `forceGuiPrompt` | **`True`** | inverted checkbox in GUI ("always show config window") — see gotcha in [`resolution-and-precedence.md`](resolution-and-precedence.md) |
| `noGui` | `False` | |
| `noStore` | `False` | |
| `room` | `""` | |
| `roomList` | `[]` | serialised |
| `password` | `None` | |
| `playerPath` | `None` | required; resolves `playerClass` as a side effect |
| `perPlayerArguments` | `None` | serialised `{path: args}` dict |
| `mediaSearchDirectories` | `None` | serialised list |
| `sharedPlaylistEnabled` | `True` | |
| `loopAtEndOfPlaylist` / `loopSingleFiles` | `False` / `False` | |
| `onlySwitchToTrustedDomains` | `True` | |
| `autosaveJoinsToList` | `True` | |
| `trustedDomains` | `["youtube.com", "youtu.be"]` | serialised |
| `file` | `None` | positional CLI arg |
| `playerArgs` | `[]` | |
| `playerClass` | `None` | computed, not persisted |
| `slowdownThreshold` | `1.5` | see [`../client/sync-algorithm.md`](../client/sync-algorithm.md) |
| `rewindThreshold` | `4` | |
| `fastforwardThreshold` | `5` | |
| `rewindOnDesync` / `slowOnDesync` / `fastforwardOnDesync` | `True` / `True` / `True` | |
| `dontSlowDownWithMe` | `False` | "Never slow down or rewind others" |
| `folderSearchFirstFileTimeout` | `25.0` | |
| `folderSearchTimeout` | `20.0` | |
| `folderSearchDoubleCheckInterval` | `30.0` | |
| `folderSearchWarningThreshold` | `2.0` | |
| `filenamePrivacyMode` / `filesizePrivacyMode` | `"SendRaw"` / `"SendRaw"` | tri-state: SendRaw/SendHashed/DoNotSend, see [`../client/privacy-and-file-matching.md`](../client/privacy-and-file-matching.md) |
| `pauseOnLeave` | `False` | |
| `readyAtStart` | `False` | |
| `unpauseAction` | `"IfOthersReady"` | one of IfAlreadyReady/IfOthersReady/IfMinUsersReady/Always |
| `autoplayInitialState` | `None` | tristate |
| `autoplayMinUsers` | `-1` | |
| `autoplayRequireSameFilenames` | `True` | |
| `clearGUIData` | `False` | |
| `language` | `""` | |
| `checkForUpdatesAutomatically` | `None` | tristate |
| `lastCheckedForUpdates` | `""` | |
| `resetConfig` | `False` | |
| `showOSD` / `showOSDWarnings` / `showSlowdownOSD` / `showSameRoomOSD` / `showDurationNotification` / `showContactInfo` | all `True` | |
| `showDifferentRoomOSD` / `showNonControllerOSD` | `False` / `False` | |
| `chatInputEnabled` | `True` | |
| `chatInputFontFamily` | `'sans-serif'` | |
| `chatInputRelativeFontSize` | `24` | |
| `chatInputFontWeight` | `1` | |
| `chatInputFontUnderline` | `False` | |
| `chatInputFontColor` | `"#FFFF00"` | hex-validated |
| `chatInputPosition` | `"Top"` | Top/Middle/Bottom |
| `chatDirectInput` | `False` | |
| `chatOutputEnabled` | `True` | |
| `chatOutputFontFamily` / `RelativeFontSize` / `FontWeight` / `FontUnderline` | same defaults as input | |
| `chatOutputMode` | `"Chatroom"` | Chatroom/Scrolling |
| `chatMaxLines` | `7` | note: stored as `7.0` due to blanket `_numeric` coercion |
| `chatTopMargin` / `chatLeftMargin` / `chatBottomMargin` / `chatOSDMargin` | `25` / `20` / `30` / `110` | |
| `chatMoveOSD` | `True` | |
| `notificationTimeout` / `alertTimeout` / `chatTimeout` | `3` / `5` / `7` (seconds) | |
| `publicServers` | `[]` | serialised |
| `loadPlaylistFromFile` | `None` | |

Runtime-only, never persisted: `loadedRelativePaths`, `menuBar` (GUI-set, macOS only).

## `.syncplay` / `syncplay.ini` file schema (`_iniStructure`, lines 193-230)

Four sections:
- **`server_data`**: `host`, `port`, `password`
- **`client_settings`**: `name`, `room`, `roomList`, `playerPath`, `perPlayerArguments`, all sync
  thresholds, folder-search timings, desync-reaction flags, `forceGuiPrompt`, privacy modes,
  `unpauseAction`, `pauseOnLeave`, `readyAtStart`, autoplay settings, `mediaSearchDirectories`,
  playlist flags, `trustedDomains`, `publicServers`
- **`gui`**: all OSD/chat display settings
- **`general`**: `language`, `checkForUpdatesAutomatically`, `lastCheckedForUpdates`

Keys not listed here (`debug`, `noGui`, `file`, `playerArgs`, `resetConfig`, `showOSD` — wait,
`showOSD` *is* in `gui` — check the actual section list for any given key before assuming it
persists) never round-trip through the file.
