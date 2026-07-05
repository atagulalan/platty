import React from 'react'
import { Box, Text } from 'ink'
import type { UserInfo } from '../../client/UserList.js'
import { scrollWindow } from './scrollWindow.js'

export interface UserListPanelProps {
  users: UserInfo[]
  selfUsername: string
  /** Current room; used for the collapsed readiness summary. */
  room?: string
  /** Render inside a shared outer border (no own box chrome). */
  embedded?: boolean
  focused?: boolean
  /** Index into the flattened (room-grouped) user list, for a read-only highlight cursor. */
  cursorIndex?: number
  width?: number
  /** Terminal rows in the scrollable content area when expanded. */
  visibleLines?: number
}

type UserListRow =
  | { kind: 'room'; room: string }
  | { kind: 'user-name'; user: UserInfo; userIndex: number }
  | { kind: 'user-file'; user: UserInfo; userIndex: number }

function readySummary(
  users: UserInfo[],
  room?: string
): { icon: string; iconColor: 'green' | 'gray'; text: string } {
  const list = room ? users.filter((u) => u.room === room) : users
  const total = list.length
  const readyCount = list.filter((u) => u.ready === true).length

  if (total > 0 && readyCount === total) {
    return { icon: '✓', iconColor: 'green', text: 'All ready' }
  }
  return {
    icon: '○',
    iconColor: 'gray',
    text: total === 0 ? '0/0 ready' : `${readyCount}/${total} ready`
  }
}

function fileLabel(u: UserInfo): string {
  if (!u.file) return '(no file)'
  const mins = Math.floor(u.file.duration / 60)
  const secs = Math.floor(u.file.duration % 60)
  return `${u.file.name} (${mins}:${secs.toString().padStart(2, '0')})`
}

function buildUserListRows(byRoom: Map<string, UserInfo[]>): UserListRow[] {
  const rows: UserListRow[] = []
  let userIndex = 0
  for (const [roomName, roomUsers] of byRoom) {
    rows.push({ kind: 'room', room: roomName })
    for (const u of roomUsers) {
      rows.push({ kind: 'user-name', user: u, userIndex })
      rows.push({ kind: 'user-file', user: u, userIndex })
      userIndex++
    }
  }
  return rows
}

function collapsedUsersLine(
  summary: ReturnType<typeof readySummary>
): React.JSX.Element {
  return (
    <Box justifyContent="space-between">
      <Text bold>Users</Text>
      <Text>
        <Text color={summary.iconColor}>{summary.icon}</Text> {summary.text}
      </Text>
    </Box>
  )
}

export function UserListPanel({
  users,
  selfUsername,
  room,
  embedded = false,
  focused = false,
  cursorIndex = 0,
  width = 24,
  visibleLines = 6
}: UserListPanelProps): React.JSX.Element {
  const summary = readySummary(users, room)

  const byRoom = new Map<string, UserInfo[]>()
  for (const u of users) {
    const list = byRoom.get(u.room) ?? []
    list.push(u)
    byRoom.set(u.room, list)
  }

  if (!focused) {
    if (embedded) {
      return collapsedUsersLine(summary)
    }

    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        width={width}
        height={3}
        overflow="hidden"
      >
        {collapsedUsersLine(summary)}
      </Box>
    )
  }

  const rows = buildUserListRows(byRoom)
  const cursorRow = rows.findIndex(
    (row) => row.kind === 'user-name' && row.userIndex === cursorIndex
  )
  const { start, end } = scrollWindow(
    rows.length,
    visibleLines,
    cursorRow === -1 ? 0 : cursorRow
  )
  const visibleRows = rows.slice(start, end)
  const hint = `${users.length} total`

  const title = (
    <Box justifyContent="space-between">
      <Text bold underline color={embedded ? 'yellow' : undefined}>
        Users
      </Text>
      <Text dimColor>{hint}</Text>
    </Box>
  )
  const userRows = (
    <Box flexDirection="column" height={visibleLines} overflow="hidden">
      {visibleRows.map((row, offset) => {
        const key = `${start + offset}-${row.kind}-${
          row.kind === 'room' ? row.room : row.user.username
        }`
        if (row.kind === 'room') {
          return (
            <Text key={key} color="cyan">
              {row.room}
            </Text>
          )
        }
        if (row.kind === 'user-name') {
          const u = row.user
          const isCursor = cursorIndex === row.userIndex
          return (
            <Text
              key={key}
              bold={u.username === selfUsername}
              inverse={isCursor}
              wrap="truncate-end"
            >
              {isCursor ? '›' : ' '}
              {u.ready ? '✓' : '○'} {u.username}
              {u.controller ? ' (op)' : ''}
            </Text>
          )
        }
        return (
          <Text key={key} dimColor wrap="truncate-end">
            {'  '}
            {fileLabel(row.user)}
          </Text>
        )
      })}
    </Box>
  )

  if (embedded) {
    return (
      <Box flexDirection="column" height={visibleLines + 1} overflow="hidden">
        {title}
        {userRows}
      </Box>
    )
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      width={width}
      height={visibleLines + 3}
      overflow="hidden"
    >
      {title}
      {userRows}
    </Box>
  )
}
