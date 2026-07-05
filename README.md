# Platty

Platty is a Syncplay-compatible watch-together client with a terminal (Ink/React) GUI. Built on
the protocol specs in [`../spec/`](../spec/), compatible with the original Python Syncplay
implementation in [`../source/`](../source/).

## Quick start

```sh
npm install

# Terminal 1: start a server
npm run server -- --port 8999

# Terminal 2: first launch runs the setup wizard (name, server, room, media dirs, player)
npm run platty -- --host 127.0.0.1 --port 8999 --player null

# Or with a real player:
npm run platty -- --host 127.0.0.1 --port 8999 --player mpv /path/to/video.mkv
```

### Configuration

Settings are stored in `~/.config/platty/platty.ini` using the same INI schema as Syncplay's
`syncplay.ini` (sections: `server_data`, `client_settings`, `gui`, `general`, plus a `[platty]`
section for TUI-specific options).

On first launch, a setup wizard collects username, server, port, room, password, media
directories, and player. Re-run it anytime with `/setup`.

CLI flags override saved config for that session:

| Flag | Config key |
|------|------------|
| `-a, --host` | host |
| `--port` | port |
| `-n, --name` | name |
| `-r, --room` | room |
| `-p, --password` | password |
| `--player` | playerKind (mpv \| vlc \| null) |
| `--player-path` | playerPath |
| `--setup` | force the setup wizard |

### Commands

Chat box doubles as a command line — type a message, or a `/command`. Tab-completes
command names and file paths; `/help` shows the essential set below, `/toggle-power-user`
reveals the rest (playlist undo, offset, operator auth, `/set`, and more — see
`src/tui/commands/registry.ts` for the full canonical list and every short-form alias).

```
/pause, /p              pause/play
/toggle, /t             toggle ready
/room, /r [room]        change room
/add, /qa <file>        add to playlist
/queueandselect, /qas   add to playlist and switch to it
/select, /qs <n>        select playlist item
/next, /qn              next item
/seek, /s <sec>         seek (+/- for relative)
/setup                  setup wizard
/config, /settings      settings
/help, /h               this help
/exit, /quit            quit
```

Ctrl+←/→ cycles panel focus (users · log · playlist, highlighted in yellow);
↑/↓ + Enter acts in the focused panel, `d`/Backspace deletes a playlist entry
without typing `/qd`; Ctrl+↓ or Esc returns focus to the input.

## Architecture

```
src/
  config/     platty.ini load/save, defaults, /set parsing (Syncplay-compatible schema)
  protocol/   wire framing, message types, ping/RTT, version negotiation, room-password hashing
  server/     Room/Watcher/RoomManager, per-connection protocol handling, MOTD, CLI
  client/     state machine, sync algorithm, playlist, userlist, privacy/file-matching
  players/    BasePlayer interface + mpv (JSON-IPC) / VLC (Lua telnet) / NullPlayer (headless)
  tui/        Ink components (status bar, user list, chat/log, playlist, setup wizard, settings)
  bin/        CLI entry points (platty-client, syncplay-server)
test/
  smoke.ts    end-to-end test: real server + two real clients (NullPlayer), no mpv/VLC needed
```

## Known scope cuts vs. the reference implementation

- **No TLS.** The server always replies `TLS.startTLS=false`; connections are always plaintext.
- **No SQLite persistence** on the server side.
- **No per-directory `.syncplay` file precedence chain** — config lives in `~/.config/platty/`.
- **GUI/OSD settings** apply to the mpv/VLC player overlay (via `syncplayintf.lua` for mpv). The TUI log mirrors the same notification text.

## Testing

```sh
npm run typecheck   # tsc --noEmit
npm test            # end-to-end smoke test (server + 2 clients, NullPlayer, no external deps)
```
