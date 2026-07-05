import React from 'react'
import { Box, Text } from 'ink'
import { scrollWindow } from './scrollWindow.js'

export interface PlaylistPanelProps {
  files: string[]
  index: number | null
  /** Render inside a shared outer border (no own box chrome). */
  embedded?: boolean
  focused?: boolean
  /** Local (client-side) navigation cursor, distinct from the server-authoritative `index`. */
  cursorIndex?: number
  width?: number
  /** Number of playlist rows shown at once (content area only). */
  visibleLines?: number
}

export function PlaylistPanel({
  files,
  index,
  embedded = false,
  focused = false,
  cursorIndex = 0,
  width = 24,
  visibleLines = 9
}: PlaylistPanelProps): React.JSX.Element {
  const scrollAnchor = focused
    ? cursorIndex
    : index !== null
      ? index
      : cursorIndex
  const { start, end } = scrollWindow(files.length, visibleLines, scrollAnchor)
  const visible = files.slice(start, end)
  const hiddenAbove = start
  const hiddenBelow = Math.max(0, files.length - end)
  const hiddenCount = hiddenAbove + hiddenBelow
  const scrollHint = hiddenCount === 0 ? '' : ` · ${hiddenCount} more`

  const title = (
    <Text bold color={embedded && focused ? 'yellow' : undefined}>
      Playlist
      <Text dimColor>{scrollHint}</Text>
    </Text>
  )
  const playlistRows = (
    <Box flexDirection="column" height={visibleLines} overflow="hidden">
      {files.length === 0 && <Text dimColor>(empty)</Text>}
      {visible.map((f, offset) => {
        const i = start + offset
        const isCursor = focused && i === cursorIndex
        return (
          <Text
            key={`${i}-${f}`}
            color={i === index ? 'green' : undefined}
            inverse={isCursor}
            wrap="truncate-end"
          >
            {i === index ? '▶' : ' '}
            {isCursor ? '›' : ' '}
            {i + 1}. {f}
          </Text>
        )
      })}
    </Box>
  )

  if (embedded) {
    return (
      <Box flexDirection="column" height={visibleLines + 1} overflow="hidden">
        {title}
        {playlistRows}
      </Box>
    )
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? 'yellow' : 'gray'}
      paddingX={1}
      width={width}
      height={visibleLines + 3}
      overflow="hidden"
    >
      {title}
      {playlistRows}
    </Box>
  )
}
