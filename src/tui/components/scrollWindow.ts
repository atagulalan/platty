/** Slice a list so `cursorIndex` stays visible within `visibleLines` rows. */
export function scrollWindow(
  count: number,
  visibleLines: number,
  cursorIndex: number
): { start: number; end: number } {
  if (count <= visibleLines) return { start: 0, end: count }
  const maxStart = count - visibleLines
  let start = Math.min(
    Math.max(0, cursorIndex - Math.floor(visibleLines / 2)),
    maxStart
  )
  if (cursorIndex < start) start = cursorIndex
  if (cursorIndex >= start + visibleLines)
    start = cursorIndex - visibleLines + 1
  start = Math.max(0, Math.min(start, maxStart))
  return { start, end: start + visibleLines }
}
