import React from 'react'
import { Box, Text } from 'ink'
import {
  renderSuggestionOverlayLine,
  suggestionOverlayLineCount,
  type SuggestionOverlayState
} from './SuggestionOverlay.js'

export interface LogLine {
  id: number
  text: string
  kind: 'chat' | 'system' | 'error'
}

export interface LogPanelProps {
  lines: LogLine[]
  height: number
  scrollOffset: number
  /** Inner text column count; lines are truncated and space-padded to clear terminal ghosts. */
  contentWidth: number
  focused?: boolean
  /** Autocomplete list painted over the bottom chat rows (layout height unchanged). */
  overlaySuggestions?: SuggestionOverlayState | null
}

/** One terminal row: clip then pad so shorter replacements erase prior longer output. */
function fitLogLine(text: string, width: number): string {
  const clipped = text.length > width ? text.slice(0, width) : text
  return clipped.padEnd(width, ' ')
}

const COLOR: Record<LogLine['kind'], string | undefined> = {
  chat: undefined,
  system: 'gray',
  error: 'red'
}

export function LogPanel({
  lines,
  height,
  scrollOffset,
  contentWidth,
  focused = false,
  overlaySuggestions = null
}: LogPanelProps): React.JSX.Element {
  const overlayLines = suggestionOverlayLineCount(overlaySuggestions)
  const chatRows = Math.max(0, height - overlayLines)
  const maxOffset = Math.max(0, lines.length - height)
  const offset = Math.min(scrollOffset, maxOffset)
  const start = Math.max(0, lines.length - height - offset)
  const visible = lines.slice(start, start + height)

  const scrollHint =
    lines.length <= height
      ? ''
      : offset === 0
        ? ' · PgUp for older'
        : offset >= maxOffset
          ? ' · PgDn for newer'
          : ' · PgUp/PgDn scroll'

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? 'yellow' : 'gray'}
      paddingX={1}
      flexGrow={1}
      flexShrink={1}
      minWidth={0}
      overflow="hidden"
      height={height + 2}
    >
      <Text bold>
        Chat
        <Text dimColor>{scrollHint}</Text>
      </Text>
      <Box flexDirection="column" height={height} overflow="hidden">
        {Array.from({ length: height }, (_, i) => {
          if (i < chatRows) {
            const line = visible[i]
            if (line) {
              return (
                <Text key={line.id} color={COLOR[line.kind]}>
                  {fitLogLine(line.text, contentWidth)}
                </Text>
              )
            }
            return (
              <Text key={`empty-${start + i}`}>
                {fitLogLine('', contentWidth)}
              </Text>
            )
          }

          const overlayIndex = i - chatRows
          const overlay = overlaySuggestions!
          const line = renderSuggestionOverlayLine(
            overlay,
            overlayIndex,
            contentWidth
          )
          return (
            <Text
              key={line.key}
              dimColor={!line.selected}
              inverse={line.selected}
            >
              {line.text}
            </Text>
          )
        })}
      </Box>
    </Box>
  )
}
