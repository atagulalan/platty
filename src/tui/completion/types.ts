// Shared types for the TUI autocomplete/suggestion system.
// See ../../spec/config/tui-ux-plan.md Phase 3.

/** A request to compute completions for the current state of the input line. */
export interface CompletionRequest {
  /** Full raw input line, e.g. "/qa /home/xava/Mov" */
  line: string;
  /** Cursor position within `line` (defaults to end-of-line if not tracked separately). */
  cursor: number;
}

export interface CompletionResult {
  /** Replacement candidates for the token currently being completed, in priority order. */
  suggestions: string[];
  /** Index into `line` where the token being completed starts, so callers can splice a chosen suggestion in. */
  replaceFrom: number;
}

export const NO_COMPLETIONS: CompletionResult = { suggestions: [], replaceFrom: 0 };

/** Max candidates returned per completion source (overlay scrolls within this cap). */
export const MAX_COMPLETION_RESULTS = 100;
