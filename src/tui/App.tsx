import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, useInput, useStdout } from 'ink'
import type { SyncplayClient } from '../client/SyncplayClient.js'
import type { UserInfo } from '../client/UserList.js'
import type { ConnectionStatus } from './components/StatusBar.js'
import { LeftColumnPanel } from './components/LeftColumnPanel.js'
import { LogPanel, type LogLine } from './components/LogPanel.js'
import { CommandInput } from './components/CommandInput.js'
import { dispatchCommand } from './commands/dispatch.js'
import type { CommandContext } from './commands/registry.js'
import { listSettableKeys } from '../config/setValue.js'

export interface AppProps {
  client: SyncplayClient
  host: string
  port: number
  /** Config's configured room, used as the /room command's last-resort fallback (Python's `defaultRoom`). */
  defaultRoom?: string
  /** Push extra internal state-change lines to the log (from --debug). */
  debug?: boolean
  onSetup?: () => void
  onSettings?: () => void
  onSet?: (key: string, value: string) => string
  onExit?: () => void
}

let logIdSeq = 0

/** Chat log rows — reclaimed the old top status bar height (+3). */
const LOG_HEIGHT = 17
const LEFT_PANEL_WIDTH = 25
const LEFT_PANEL_HEIGHT = LOG_HEIGHT + 2
/** Rows between the outer top/bottom border of the unified left column. */
const LEFT_PANEL_INNER_HEIGHT = LEFT_PANEL_HEIGHT - 2
const CONNECTION_HEADER_LINES = 1
const USER_LIST_COLLAPSED_LINES = 1
const PLAYLIST_MIN_VISIBLE_LINES = 2
const SECTION_DIVIDER_LINES = 1
const SECTION_TITLE_LINES = 1
/** Connection header + divider below it, always reserved at the top. */
const TOP_SECTION_OVERHEAD = CONNECTION_HEADER_LINES + SECTION_DIVIDER_LINES

function userListVisibleLines(focusedPanel: PanelFocus): number {
  if (focusedPanel !== 'users') return 0
  const playlistBlock = SECTION_TITLE_LINES + PLAYLIST_MIN_VISIBLE_LINES
  return (
    LEFT_PANEL_INNER_HEIGHT -
    TOP_SECTION_OVERHEAD -
    SECTION_DIVIDER_LINES -
    playlistBlock -
    SECTION_TITLE_LINES
  )
}

function playlistVisibleLines(focusedPanel: PanelFocus): number {
  if (focusedPanel === 'users') return PLAYLIST_MIN_VISIBLE_LINES
  return (
    LEFT_PANEL_INNER_HEIGHT -
    TOP_SECTION_OVERHEAD -
    SECTION_DIVIDER_LINES -
    USER_LIST_COLLAPSED_LINES -
    SECTION_TITLE_LINES
  )
}

/** Which panel currently owns arrow-key input; "input" is the default (text entry). */
type PanelFocus = 'users' | 'log' | 'playlist' | 'input'

/** Cycle order for Ctrl+Left/Right — matches layout: left column top→bottom, then log. */
const PANEL_CYCLE: readonly PanelFocus[] = ['users', 'playlist', 'log']

function cyclePanel(current: PanelFocus, direction: 1 | -1): PanelFocus {
  const idx = PANEL_CYCLE.indexOf(current)
  if (idx === -1) {
    // Coming from "input": Ctrl+Right enters at the start, Ctrl+Left enters at the end.
    return direction === 1
      ? PANEL_CYCLE[0]!
      : PANEL_CYCLE[PANEL_CYCLE.length - 1]!
  }
  return PANEL_CYCLE[
    (idx + direction + PANEL_CYCLE.length) % PANEL_CYCLE.length
  ]!
}

/** Key hints shown in the input bar while a panel (not the input) owns focus. */
const PANEL_HINT: Record<Exclude<PanelFocus, 'input'>, string> = {
  users: 'panel mode: users — ↑/↓ highlight · esc input',
  log: 'panel mode: log — ↑/↓ scroll · esc input',
  playlist:
    'panel mode: playlist — ↑/↓ move · enter select · d delete · esc input'
}

export function App({
  client,
  host,
  port,
  defaultRoom,
  debug,
  onSetup,
  onSettings,
  onSet,
  onExit
}: AppProps): React.JSX.Element {
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [username, setUsername] = useState(client.selfUsername)
  const [room, setRoom] = useState(client.currentRoom)
  const [ready, setReady] = useState<boolean | null>(client.isReady)
  const [users, setUsers] = useState<UserInfo[]>([])
  const [playlist, setPlaylist] = useState<{
    files: string[]
    index: number | null
  }>({ files: [], index: null })
  const [lines, setLines] = useState<LogLine[]>([])
  const [logScroll, setLogScroll] = useState(0)
  const [powerUserMode, setPowerUserMode] = useState(false)
  const [focusedPanel, setFocusedPanel] = useState<PanelFocus>('input')
  const [playlistCursor, setPlaylistCursor] = useState(0)
  const [usersCursor, setUsersCursor] = useState(0)
  const [inputSuggestions, setInputSuggestions] = useState<{
    items: string[]
    selectedIndex: number | null
  } | null>(null)
  const settableKeys = useMemo(() => listSettableKeys(), [])
  const { stdout } = useStdout()
  // Border (2) + paddingX (2) inside the log panel content area.
  const logContentWidth = Math.max(
    1,
    (stdout.columns ?? 80) - LEFT_PANEL_WIDTH - 4
  )

  const pushLine = (text: string, kind: LogLine['kind'] = 'system'): void => {
    const parts = text.split(/\r?\n/)
    setLines((prev) => {
      const newLines = parts.map((part) => ({
        id: logIdSeq++,
        text: part,
        kind
      }))
      return [...prev, ...newLines].slice(-200)
    })
    setLogScroll((prev) => (prev === 0 ? 0 : prev + parts.length))
  }
  const pushLineRef = useRef(pushLine)
  pushLineRef.current = pushLine

  const commandCtxRef = useRef<CommandContext | null>(null)
  commandCtxRef.current = {
    client,
    host,
    port,
    connectionStatus: status,
    room,
    defaultRoom,
    pushLine,
    onSetup,
    onSettings,
    onSet,
    onExit,
    powerUserMode,
    setPowerUserMode
  }

  useEffect(() => {
    setStatus('connecting')
    const onConnected = (info: {
      username: string
      room: string
      motd: string
      requestedUsername?: string
    }): void => {
      setStatus('connected')
      setUsername(info.username)
      setRoom(info.room)
      if (info.requestedUsername) {
        pushLineRef.current(
          `Username "${info.requestedUsername}" was already in use; assigned "${info.username}"`
        )
      }
      pushLineRef.current(
        `Connected as ${info.username} in room "${info.room}"`
      )
      if (info.motd) pushLineRef.current(info.motd)
    }
    const onDisconnected = (): void => setStatus('disconnected')
    const onReconnecting = (delay: number): void => {
      setStatus('reconnecting')
      pushLineRef.current(`Reconnecting in ${Math.round(delay)}ms...`)
    }
    const onUserlistUpdate = (): void => {
      setUsers(client.userList.all())
      setReady(client.isReady)
      if (debug)
        pushLineRef.current(
          `[debug] user list updated (${client.userList.all().length} users)`
        )
    }
    const onPlaylistUpdate = (): void => {
      setPlaylist({
        files: client.playlist.files,
        index: client.playlist.index
      })
      if (debug) {
        pushLineRef.current(
          `[debug] playlist updated (${client.playlist.files.length} files, index ${client.playlist.index})`
        )
      }
    }
    const onChat = (): void => {
      /* chat lines are logged by PlayerPresenter.showChatMessage */
    }
    const onLog = (text: string): void => {
      const kind: LogLine['kind'] = /^<[^>]+> /.test(text) ? 'chat' : 'system'
      pushLineRef.current(text, kind)
    }
    const onError = (message: string): void =>
      pushLineRef.current(`Error: ${message}`, 'error')

    const onPlayerInput = (cmd: string): void => {
      const ctx = commandCtxRef.current
      if (ctx) dispatchCommand(cmd, ctx)
    }

    client.on('connected', onConnected)
    client.on('disconnected', onDisconnected)
    client.on('reconnecting', onReconnecting)
    client.on('userlistUpdate', onUserlistUpdate)
    client.on('playlistUpdate', onPlaylistUpdate)
    client.on('chat', onChat)
    client.on('log', onLog)
    client.on('error', onError)
    client.on('playerInput', onPlayerInput)

    return () => {
      client.off('connected', onConnected)
      client.off('disconnected', onDisconnected)
      client.off('reconnecting', onReconnecting)
      client.off('userlistUpdate', onUserlistUpdate)
      client.off('playlistUpdate', onPlaylistUpdate)
      client.off('chat', onChat)
      client.off('log', onLog)
      client.off('error', onError)
      client.off('playerInput', onPlayerInput)
    }
  }, [client, debug])

  // Clamp the playlist navigation cursor whenever the playlist shrinks/grows (e.g. after a delete).
  useEffect(() => {
    setPlaylistCursor((c) =>
      playlist.files.length === 0
        ? 0
        : Math.max(0, Math.min(c, playlist.files.length - 1))
    )
  }, [playlist.files.length])

  // Keep the navigation cursor on the active item unless the playlist panel is focused.
  useEffect(() => {
    if (focusedPanel === 'playlist') return
    if (playlist.index !== null && playlist.files.length > 0) {
      setPlaylistCursor(playlist.index)
    }
  }, [focusedPanel, playlist.index, playlist.files.length])

  // Clamp the read-only users highlight cursor whenever the user list changes.
  useEffect(() => {
    setUsersCursor((c) =>
      users.length === 0 ? 0 : Math.max(0, Math.min(c, users.length - 1))
    )
  }, [users.length])

  useInput((input, key) => {
    // Ctrl+arrow always switches panel focus, regardless of what's currently focused
    // (including switching away from "input").
    if (key.ctrl && key.rightArrow) {
      setFocusedPanel((f) => cyclePanel(f, 1))
      return
    }
    if (key.ctrl && key.leftArrow) {
      setFocusedPanel((f) => cyclePanel(f, -1))
      return
    }
    if (key.ctrl && key.downArrow) {
      setFocusedPanel('input')
      return
    }

    if (focusedPanel === 'input') {
      // Baseline behavior preserved: PageUp/PageDown scroll the log as a convenience
      // even while the text input has focus. All other keys go to the text input itself.
      const maxOffset = Math.max(0, lines.length - LOG_HEIGHT)
      if (key.pageUp) setLogScroll((s) => Math.min(maxOffset, s + LOG_HEIGHT))
      if (key.pageDown) setLogScroll((s) => Math.max(0, s - LOG_HEIGHT))
      return
    }

    // A panel (not input) is focused: Esc always returns focus to the input bar.
    if (key.escape) {
      setFocusedPanel('input')
      return
    }

    if (focusedPanel === 'log') {
      const maxOffset = Math.max(0, lines.length - LOG_HEIGHT)
      if (key.pageUp) setLogScroll((s) => Math.min(maxOffset, s + LOG_HEIGHT))
      if (key.pageDown) setLogScroll((s) => Math.max(0, s - LOG_HEIGHT))
      if (key.upArrow) setLogScroll((s) => Math.min(maxOffset, s + 1))
      if (key.downArrow) setLogScroll((s) => Math.max(0, s - 1))
      return
    }

    if (focusedPanel === 'playlist') {
      const count = playlist.files.length
      if (key.upArrow || input === 'k') {
        setPlaylistCursor((c) => (count === 0 ? 0 : Math.max(0, c - 1)))
      }
      if (key.downArrow || input === 'j') {
        setPlaylistCursor((c) => (count === 0 ? 0 : Math.min(count - 1, c + 1)))
      }
      if (key.return) {
        if (count > 0) client.selectPlaylistIndex(playlistCursor)
      }
      if (input === 'd' || key.backspace) {
        if (count > 0) {
          client.removeFromPlaylist(playlistCursor)
          setPlaylistCursor((c) => Math.max(0, Math.min(c, count - 2)))
        }
      }
      return
    }

    if (focusedPanel === 'users') {
      const count = users.length
      if (key.upArrow)
        setUsersCursor((c) => (count === 0 ? 0 : Math.max(0, c - 1)))
      if (key.downArrow)
        setUsersCursor((c) => (count === 0 ? 0 : Math.min(count - 1, c + 1)))
      return
    }
  })

  const handleSubmit = (raw: string): void => {
    if (!raw) return
    if (raw.startsWith('//')) {
      // "//text" escapes to a literal chat message starting with a single "/".
      const text = raw.slice(1)
      client.sendChat(text)
      return
    }
    if (!raw.startsWith('/')) {
      client.sendChat(raw)
      return
    }
    const ctx: CommandContext = {
      client,
      host,
      port,
      connectionStatus: status,
      room,
      defaultRoom,
      pushLine,
      onSetup,
      onSettings,
      onSet,
      onExit,
      powerUserMode,
      setPowerUserMode
    }
    dispatchCommand(raw.slice(1), ctx)
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" width="100%">
        <LeftColumnPanel
          status={status}
          powerUserMode={powerUserMode}
          users={users}
          selfUsername={username}
          room={room}
          usersFocused={focusedPanel === 'users'}
          usersCursorIndex={usersCursor}
          usersVisibleLines={userListVisibleLines(focusedPanel)}
          playlistFiles={playlist.files}
          playlistIndex={playlist.index}
          playlistFocused={focusedPanel === 'playlist'}
          playlistCursorIndex={playlistCursor}
          playlistVisibleLines={playlistVisibleLines(focusedPanel)}
          width={LEFT_PANEL_WIDTH}
          height={LEFT_PANEL_HEIGHT}
        />
        <LogPanel
          lines={lines}
          height={LOG_HEIGHT}
          scrollOffset={logScroll}
          contentWidth={logContentWidth}
          focused={focusedPanel === 'log'}
          overlaySuggestions={
            focusedPanel === 'input' ? inputSuggestions : null
          }
        />
      </Box>
      <CommandInput
        onSubmit={handleSubmit}
        username={username}
        ready={ready}
        powerUserMode={powerUserMode}
        playlistFiles={playlist.files}
        users={users}
        settableKeys={settableKeys}
        active={focusedPanel === 'input'}
        hint={focusedPanel === 'input' ? undefined : PANEL_HINT[focusedPanel]}
        onSuggestionsChange={setInputSuggestions}
      />
    </Box>
  )
}
