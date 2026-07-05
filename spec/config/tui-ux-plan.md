---
id: tui-ux-plan
title: "Platty TUI UX Plan: Autocomplete, Tiered Help, Panel Navigation"
tags: [config, ui, tui, commands, autocomplete, plan]
related: ["[[ui-and-commands]]", "[[../client/playlist-and-readiness]]"]
status: planned
---

# Platty TUI UX Plan: Autocomplete, Tiered Help, Panel Navigation

Plan for five related improvements to the Platty TypeScript TUI client (`ts/`). Today everything lives inline in `App.tsx` with a plain `ink-text-input` and read-only side panels — the work starts with a small refactor, then layers UX on top.

**Requested features:**

1. Auto-completion when filling commands and opening files
2. Every short slash command has a long version
3. Tiered `/help`: essential commands by default; advanced commands behind `/toggle-power-user`
4. Three-panel navigation with Ctrl+arrow keys; active panel highlighted orange
5. Interactive playlist panel (↑/↓ + Enter to select, delete without `/qd`)
6. `/qa <file>` accepts absolute paths with folder-aware auto-suggestions

---

## Current State (Baseline)

| Area | Today |
|---|---|
| Commands | Hard-coded `switch` + static `HELP_LINES` in `ts/src/tui/App.tsx` |
| Aliases | Some long forms exist (`/pause`, `/add`, `/delete`) but many Python parity aliases are missing (`/play`, `/queue`, `/d`, `/c`, `/a`, `/chat`, `/revert`, `/playlist`) |
| Input | No Tab completion, no suggestions (`ts/src/tui/components/InputBar.tsx`) |
| Panels | Users · Log · Playlist — all `borderColor="gray"`, no focus |
| Keyboard | Only PgUp/PgDn scrolls the log; `SettingsPanel.tsx` already has ↑/↓ navigation |
| `/qa` paths | Accepts absolute paths, but strips to basename before sending to server; no validation or completion |

### Key files

```
ts/src/tui/App.tsx              — command dispatch, panel layout, log scroll
ts/src/tui/components/InputBar.tsx
ts/src/tui/components/UserListPanel.tsx
ts/src/tui/components/LogPanel.tsx
ts/src/tui/components/PlaylistPanel.tsx
ts/src/tui/SettingsPanel.tsx    — reference for list keyboard nav
ts/src/client/SyncplayClient.ts — command backends
ts/src/client/Playlist.ts       — /qa path stripping
ts/src/client/FileSwitchManager.ts — path resolution on switch
ts/src/config/setValue.ts       — /set parsing
ts/src/config/iniStructure.ts   — CONFIG_ALIASES, CONFIG_FIELDS
spec/config/ui-and-commands.md  — reference command table
source/syncplay/constants.py    — canonical alias lists
```

---

## Phase 0 — Command Registry (Foundation)

Extract commands from `App.tsx` into `ts/src/tui/commands/`:

```ts
interface CommandDef {
  name: string;           // canonical long name, e.g. "add"
  aliases: string[];      // all forms including name, e.g. ["add", "qa", "queue"]
  tier: "basic" | "power";
  usage: string;          // for help text
  complete?: (ctx: CommandContext, partial: string) => string[];
  handler: (ctx: CommandContext, arg: string) => void;
}
```

**Benefits:** single source of truth for dispatch, help, and autocomplete; eliminates duplicated `HELP_LINES` vs `switch` drift.

### Alias policy

Every short form gets an explicit long canonical name. Fill gaps from `source/syncplay/constants.py`:

| Short | Long (canonical) | Tier |
|---|---|---|
| `/p` | `/pause` (+ add `/play`) | basic |
| `/t` | `/toggle` | basic |
| `/r` | `/room` | basic |
| `/qa` | `/add` (+ `/queue`) | basic |
| `/qas` | `/queueandselect` | basic |
| `/qs` | `/select` | basic |
| `/qn` | `/next` | basic |
| `/s` | `/seek` | basic |
| `/qd` | `/delete` (+ `/d`) | power |
| `/u` | `/undo` (+ `/revert`) | power |
| `/auth` | — (+ add `/a`) | power |
| `/create` | — (+ add `/c`) | power |
| `/o` | `/offset` | power |
| `/l` | `/list`, `/users` | power |
| `/sr` | `/setready` | power |
| `/snr` | `/setnotready` | power |
| `/set` | — | power |
| `/help` | `/h`, `/?` | basic |
| `/config` | `/settings` | basic |
| `/exit` | `/quit` | basic |

Platty-only: `/setup`, `/toggle-power-user` (new).

---

## Phase 1 — Tiered Help + Power-User Mode

### `/toggle-power-user`

- Session flag in `App.tsx` (optionally persist in config as `powerUserMode: boolean`).
- Toggles between basic and power command visibility.
- Small indicator in `StatusBar`: e.g. `PU` badge when on.

### `/help` content

**Basic (default):**

```
Commands:
  /pause, /p              pause/play
  /toggle, /t             toggle ready
  /room, /r [room]        change room
  /add, /qa <file>        add to playlist
  /queueandselect, /qas   add and switch
  /select, /qs <n>        select playlist item
  /next, /qn              next item
  /seek, /s <sec>         seek (+/- for relative)
  /setup                  setup wizard
  /config, /settings      settings
  /help, /h               this help
  /exit, /quit            quit

Navigation:
  Ctrl+←/→                switch panel (users · log · playlist)
  ↑/↓ Enter               act in focused panel
  //text                  literal chat starting with /
```

**Hidden from basic help** (power-user only):

- `/sr`, `/snr` — mark another user ready/not ready
- `/offset`, `/o` — A/V offset
- `/list`, `/l`, `/users` — list users per room
- `/auth` — authenticate operator
- `/undo`, `/u` — playlist undo
- `/delete`, `/qd` — remove playlist item (use panel navigation instead)
- `/set`, `/create`

**Power-user `/help`:** append a second block with the advanced commands above plus `/toggle-power-user` to turn the mode off.

Unknown commands: show basic help snippet (match Python behavior) instead of only `"Unknown command"`.

---

## Phase 2 — Panel Focus + Ctrl+Arrow Navigation

### Focus model

```ts
type PanelFocus = "users" | "log" | "playlist" | "input";
```

| Key | Behavior |
|---|---|
| `Ctrl+←` / `Ctrl+→` | Cycle focus: users → log → playlist → users |
| `Ctrl+↓` | Focus input bar |
| `Esc` (input empty) | Return focus to last panel |
| Active panel | `borderColor="yellow"` or orange |

Each panel gets `focused: boolean` prop; inactive panels stay gray.

### Per-panel actions (when not in input)

| Panel | Keys | Action |
|---|---|---|
| **Log** | PgUp/PgDn, ↑/↓ | Scroll (move existing scroll logic behind `focusedPanel === "log"`) |
| **Playlist** | ↑/↓ or j/k | Move local `cursorIndex` (separate from server `index`) |
| **Playlist** | Enter | `client.selectPlaylistIndex(cursorIndex)` |
| **Playlist** | `d` or Backspace | `client.removeFromPlaylist(cursorIndex)` |
| **Users** | ↑/↓ | Scroll/highlight (read-only for v1) |

### Example workflow

Instead of `/qd 3`:

1. Esc from input (or start with no input focus)
2. `Ctrl+→` twice → playlist panel turns orange
3. ↓ to item, Enter → selects (replaces `/qs 3`)
4. `d` → deletes (replaces `/qd 3`)

### Input vs panel conflict

`ink-text-input` captures all keys. Strategy:

1. **Default focus = input** (current behavior preserved).
2. **Ctrl+arrow always switches panel** — handled in `App.useInput` before input consumes keys (verify Ink passes ctrl-modified keys to parent; may need custom input wrapper).
3. When a panel is focused, **disable or blur the text input** so ↑/↓ go to the panel. Show dim `"(panel mode — Ctrl+↓ for input)"` hint in the input bar.

Reference pattern: `SettingsPanel.tsx` separates list navigation from inline edit mode.

---

## Phase 3 — Autocomplete & Suggestions

### Enhanced InputBar

Replace bare `ink-text-input` with `CommandInput`:

```
┌─────────────────────────────────────────────────────┐
│ > /qa /home/xava/Movies/foo▮                        │
│   /home/xava/Movies/foo.mkv  /home/xava/Movies/bar.mkv │  ← suggestion row
└─────────────────────────────────────────────────────┘
```

| Key | Behavior |
|---|---|
| Tab | Accept best match / cycle command names |
| ↑/↓ | Cycle suggestions (when visible) |
| Right | Accept ghost suffix (inline completion) |
| Esc | Clear suggestions |

Ghost text: dim suffix after cursor for top match (like fish/zsh).

### Completion sources

| Context | Source |
|---|---|
| `/` + partial cmd | Filter `CommandDef.aliases` (respect power-user tier) |
| `/qa `, `/qas ` | File completer (below) |
| `/qs `, `/qd ` | `1..N` or filename substring match from playlist |
| `/set ` | `listSettableKeys()` + `CONFIG_ALIASES` from `iniStructure.ts` |
| `/sr `, `/snr ` | Usernames from `client.userList` |
| `/r ` | Known rooms from user list |

### File completer for `/qa <path>`

New module: `ts/src/tui/completion/fileCompleter.ts`

```
/qa /home/xava/Mov|          → list /home/xava/Movies/*
/qa /home/xava/Movies/foo|   → foo.mkv, foo.srt, ...
/qa foo|                     → scan mediaSearchDirectories cache (basename mode)
```

Logic:

1. If arg contains `/`, treat as path: `dirname + basename prefix`, `readdirSync(dirname)`, filter by prefix, append `/` for directories.
2. Expand `~` via `os.homedir()`.
3. Fall back to `FileSwitchManager` cache for basename-only input.
4. Cap results (~20), prioritize exact prefix matches.

**Absolute paths:** already accepted by `addToPlaylist`; completion is the main gap. Optional enhancement: if resolved path exists locally, queue basename but log `"Added foo.mkv (from /full/path)"`.

---

## Phase 4 — Polish & Parity

| Item | Detail |
|---|---|
| Error feedback | `/qa` without arg → usage error; bad `/qs` index → log warning |
| StatusBar hint | Show focused panel name + key hints on first run |
| Tests | Unit tests for command registry parse/dispatch, file completer, help tier filtering |
| Docs | Update README command table to match tiered help |

---

## Suggested File Layout

```
ts/src/tui/
  commands/
    registry.ts       # all CommandDef entries
    dispatch.ts       # parse + run
    help.ts           # tiered HELP_LINES generator
  completion/
    fileCompleter.ts
    types.ts
  components/
    CommandInput.tsx  # InputBar replacement
    UserListPanel.tsx # + focused prop
    LogPanel.tsx      # + focused prop
    PlaylistPanel.tsx # + focused, cursorIndex, onSelect, onDelete
  App.tsx             # focus state, useInput routing, thinner
```

---

## Implementation Order

```
Phase 0: Command registry
    ↓
Phase 1: Tiered help + power mode          Phase 3: Command autocomplete
    ↓                                              ↓
Phase 2: Panel focus + Ctrl+arrows  →  Phase 3b: File path autocomplete
                                              ↓
                                        Phase 4: Polish
```

1. **Registry** — unblocks everything else, low UX risk
2. **Tiered help** — quick win, matches "less noise" goal
3. **Panel navigation** — high impact, moderate Ink complexity
4. **Autocomplete** — command names first, then file paths
5. **Polish** — errors, tests, docs

**Smallest useful first PR:** Phase 0 + Phase 1 (~300–400 lines, no Ink input rewrite yet).

---

## Risks & Decisions

| Topic | Recommendation |
|---|---|
| Persist power-user mode? | Session-only first; add config key if you want it remembered |
| Delete key in playlist | `d` + Backspace (Delete may not reach Ink on all terminals) |
| `/u` semantics | Keep playlist undo; add `/revert` alias; document that Syncplay Python uses seek undo — don't change behavior silently |
| Input always focused? | No — explicit panel mode with Ctrl+↓ to return; matches keyboard-first workflow |
| Performance | Debounce `readdirSync` for large dirs; reuse `FileSwitchManager` cache for media dirs |

---

## Acceptance Criteria

- [ ] Tab completes `/qa` → `/add` and other aliases; every short command has a documented long form
- [ ] `/help` shows ~12 essential commands; `/toggle-power-user` reveals the rest
- [ ] Ctrl+←/→ cycles panels; active panel has orange/yellow border
- [ ] Playlist panel: ↑/↓ + Enter selects; `d` deletes without typing `/qd`
- [ ] `/qa /absolute/path/to/file.mkv` works with live suggestions from that directory
- [ ] Ghost/suggestion row visible below input while typing
