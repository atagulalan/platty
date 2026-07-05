export const MAX_SUGGESTION_LINES = 5

export interface SuggestionOverlayState {
  items: string[]
  /** Highlighted row, or null when the list is shown but nothing is selected yet. */
  selectedIndex: number | null
}

export interface SuggestionOverlayLine {
  text: string
  selected: boolean
  key: string
}

/** One terminal row: clip then pad so shorter replacements erase prior longer output. */
export function fitOverlayLine(text: string, width: number): string {
  const clipped = text.length > width ? text.slice(0, width) : text
  return clipped.padEnd(width, ' ')
}

export function suggestionScrollOffset(
  selectedIndex: number | null,
  totalCount: number
): number {
  if (selectedIndex === null || totalCount <= MAX_SUGGESTION_LINES) return 0
  return Math.min(
    Math.max(0, selectedIndex - MAX_SUGGESTION_LINES + 1),
    totalCount - MAX_SUGGESTION_LINES
  )
}

export function suggestionOverlayLineCount(
  overlay: SuggestionOverlayState | null | undefined
): number {
  if (!overlay || overlay.items.length === 0) return 0
  return 1 + Math.min(overlay.items.length, MAX_SUGGESTION_LINES)
}

export function renderSuggestionOverlayLine(
  overlay: SuggestionOverlayState,
  overlayIndex: number,
  width: number
): SuggestionOverlayLine {
  if (overlayIndex === 0) {
    const scrollOffset = suggestionScrollOffset(
      overlay.selectedIndex,
      overlay.items.length
    )
    const total = overlay.items.length
    const visibleEnd = scrollOffset + MAX_SUGGESTION_LINES
    const moreAbove = scrollOffset > 0
    const moreBelow = visibleEnd < total
    const hint =
      moreAbove && moreBelow
        ? ' ▲▼'
        : moreAbove
          ? ' ▲'
          : moreBelow
            ? ' ▼'
            : ''
    const ruleWidth = Math.max(0, Math.min(width, 40) - hint.length)
    return {
      text: fitOverlayLine(`${'─'.repeat(ruleWidth)}${hint}`, width),
      selected: false,
      key: 'rule'
    }
  }

  const scrollOffset = suggestionScrollOffset(
    overlay.selectedIndex,
    overlay.items.length
  )
  const itemIndex = scrollOffset + overlayIndex - 1
  const suggestion = overlay.items[itemIndex]
  if (!suggestion) {
    return {
      text: fitOverlayLine('', width),
      selected: false,
      key: `empty-${overlayIndex}`
    }
  }

  const selected =
    overlay.selectedIndex !== null && itemIndex === overlay.selectedIndex
  const prefix = selected ? '> ' : '  '
  return {
    text: fitOverlayLine(`${prefix}${suggestion}`, width),
    selected,
    key: `${itemIndex}-${suggestion}`
  }
}
