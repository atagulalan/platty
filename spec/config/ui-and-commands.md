---
id: config-ui-commands
title: "Config: GUI, Console & Chat Command Dispatch"
tags: [config, ui, gui, console, commands]
source: source/syncplay/ui/gui.py, GuiConfiguration.py, consoleUI.py, source/syncplay/messages.py
related: ["[[../README]]", "[[resolution-and-precedence]]", "[[../client/playlist-and-readiness]]", "[[../quirks-and-gotchas]]"]
---

# Config: GUI, Console & Chat Command Dispatch

## Settings dialog tabs (`GuiConfiguration.py`, `ConfigDialog.__init__`)

Built in this order:

1. **Basics** — host, username, room, password, executable path (player-detecting combobox +
   icon probe thread), media file/URL, player arguments, "show more" toggle.
2. **Readiness** — `readyAtStart`, `pauseOnLeave`, `unpauseAction` radio group
   (IfAlreadyReady/IfOthersReady/IfMinUsersReady/Always).
3. **Sync** — `slowOnDesync`, `rewindOnDesync`, `fastforwardOnDesync`, `dontSlowDownWithMe`,
   trusted-domains text edit.
4. **Chat** — `chatInputEnabled`, `chatDirectInput`, input font/color, `chatInputPosition` radio
   (Top/Middle/Bottom), `chatOutputEnabled`, output font, `chatOutputMode` radio
   (Chatroom/Scrolling).
5. **Messages** — all `showX` OSD toggles, `language` combobox.
6. **Misc** — filename/filesize privacy radio groups, `forceGuiPrompt` (inverted checkbox),
   `checkForUpdatesAutomatically`, `autosaveJoinsToList`, media-search-directories text edit,
   plus a duplicated `forceGuiPrompt`/`sharedPlaylistEnabled` pair near the bottom action area.

### Generic widget↔config binding mechanism

The actually-reusable part: every settable widget's Qt `objectName()` encodes its config key, so
one recursive tree-walk (`processWidget()`) can load/save/tooltip/connect every field without
per-field boilerplate:

| Marker | Meaning |
|---|---|
| `*` prefix | checkbox stores the boolean **negated** (`INVERTED_STATE_MARKER`) |
| `!` prefix | widget is skipped by the generic loader — value is hand-read/written elsewhere (`LOAD_SAVE_MANUALLY_MARKER`) |
| `label:configKey=value` | radio button encoding (`CONFIG_NAME_MARKER=":"`, `CONFIG_VALUE_MARKER="="`) |

Qt tristate (`PartiallyChecked`) represents `None` for tristate config keys
(`checkForUpdatesAutomatically`, `autoplayInitialState`).

Bottom buttons: **Reset** (sets `resetConfig=True`, wiping back to `_defaultConfig` on next
validation), **Run** (`noStore=True`), **Save & Run** (persists). **Closing via the X button or
Escape calls `sys.exit()` directly** — cancelling the settings prompt terminates the entire
client process, including when it's a re-prompt after a validation error.

`clearGUIData()` wipes native Qt `QSettings` groups (`PlayerList`, `MoreSettings`,
`MediaBrowseDialog`, window geometry) — separate storage from `syncplay.ini`/`.syncplay`,
backed by the registry (Windows) / plist (macOS) / config files (Linux), organization name
"Syncplay".

## Main window structure (`gui.py`, `MainWindow`)

- **Output/chat panel**: `outputbox` (read-only rich-text log of notifications+chat), chat
  input line, playback controls frame.
- **User list & rooms panel**: room-tree view (rooms → users) with custom item delegate
  painting controller/ready/file-mismatch icons; SSL padlock button (opens a certificate-info
  dialog); room combobox + join/create button; playlist panel (drag-and-drop reorderable list
  with a "currently playing" marker); Ready toggle; autoplay controls.
- **Playback controls strip** (togglable, initially hidden): seek box, undo-seek, Play/Pause.
- **Menu bar**: File (open media/stream, set media directories, reconnect, exit), Playback
  (play/pause/seek/undo), Advanced (set offset, set trusted domains, create controlled room,
  identify as controller), Window (toggle playback buttons/autoplay panel/hide-empty-rooms),
  Help (guide, check for updates, About).

## Chat / command dispatch

The GUI does **not** have its own command table — it composes the console's dispatcher.
`MainWindow` owns a `ConsoleInGUI` (a `ConsoleUI` subclass redirecting output into GUI widgets
instead of stdout). Chat submission (`sendChatMessage`):
```python
if chatText.startswith("/") and chatText != "/":
    command = chatText[1:]
    if command.startswith("/"):        # "//" escapes to a literal leading slash
        chatText = chatText[1:]
    else:
        self.executeCommand(command); return   # dispatch as command, not chat
self._syncplayClient.sendChat(chatText)
```
`executeCommand` echoes `"/{command}"` to the log then delegates to
`self.console.executeCommand(command)` — the **same** regex dispatcher used in plain console
mode.

### Full command dispatch table (`constants.py`, matched via `UI_COMMAND_REGEX =
r"^(?P<command>[^\ ]+)(?:\ (?P<parameter>.+))?"` in `ConsoleUI.executeCommand`)

| Aliases | Behavior |
|---|---|
| `u`, `undo`, `revert` | swap current position with the position before the last seek |
| `l`, `list`, `users` | print the user list |
| `ch`, `chat` | send remaining text as chat (bypasses `/`-command detection) |
| `p`, `play`, `pause` | toggle play/pause |
| `r`, `room` | switch room (no parameter → current file's name or `defaultRoom`) |
| `help`, `h`, `?`, `/?`, `\?` | full help/command list — also the fallback for unrecognized input |
| `c`, `create` | `createControlledRoom(roombasename)` |
| `a`, `auth` | `identifyAsController(controlpassword)` |
| `t`, `toggle` | toggle own readiness |
| `queue`, `qa`, `add` | add file/URL to playlist |
| `queueandselect`, `qas` | queue + immediately switch to it |
| `playlist`, `ql`, `pl` | print numbered playlist, current index starred |
| `select`, `qs` | jump to playlist index N (1-based) + rewind |
| `delete`, `d`, `qd` | remove playlist item at index N |
| `next`, `qn` | load next playlist file |
| `setready`, `sr` | mark another user ready |
| `snr` | mark another user **not** ready (see bug note below) |

Not in the table — matched separately by `_tryAdvancedCommands` only if no table command
matched: `o`/`offset [+/-]<time>` (adjust `userOffset`; bare `/<time>` sets offset relative to
current position), `s`/`seek [+/-]<time>` or a bare numeric time (absolute seek if unsigned,
relative if signed).

**Known bug**: `COMMANDS_SETNOTREADY = ['setready', 'snr']` duplicates the string `"setready"`
instead of `"setnotready"` — almost certainly a copy-paste error in the shipped source. Because
`if/elif` branch ordering checks `COMMANDS_SETREADY` first, this bug is mostly masked in
practice: the word `setready` is always caught by the ready branch, and `COMMANDS_SETNOTREADY`'s
only practically-reachable alias is `snr`. **A reimplementation should fix this typo
(`'setnotready'`) rather than replicate it**, unless exact bug-for-bug compatibility with the
reference client's command table is required.

## Console mode (`consoleUI.py`, `--no-gui`)

**Interactive**, not just log output — `ConsoleUI(threading.Thread)` runs a background daemon
thread doing a blocking `input()` loop. Two modes multiplexed via a `threading.Event
promptMode`: normal typed lines go straight to `executeCommand()`; when the client code needs an
interactive answer (e.g. typing a controller password), it calls `promptFor(prompt, message)`,
which blocks until the input thread captures the next line.

**Console commands have no leading `/`** — plain console users type `pause`, `r myroom`, `qa
file.mkv` directly, since the whole typed line is matched as `command [parameter]`. The
`/`-prefix convention is a **GUI-only** chat-vs-command disambiguation (because in the GUI,
chat and commands share one input box) — the console has no such ambiguity since there's no
separate "just chat" input. `showUserList` prints a formatted room/user tree with
`(controller)`/`(ready)` flags and per-user file info.

## i18n lookup (`messages.py`)

13 languages loaded eagerly at import (`de, en, es, eo, fi, fr, it, pt_PT, pt_BR, tr, ru, zh_CN,
ko`). `getMessage(type_, locale=None)` fallback chain: explicit `locale` param (if valid and has
the key) → current language → **hard fallback to English** → if even English lacks the key,
print a warning and **raise `KeyError`** (an older placeholder-string fallback was removed).
`SHOW_TOOLTIPS = False` globally suppresses any key containing `"-tooltip"` at the lookup layer,
not per-callsite. Initial language auto-detected from `QLocale`/`locale.getdefaultlocale()`,
falling back to `en` on any exception or unknown code.
