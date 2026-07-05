// InputBar replacement with Tab/ghost-text autocomplete. See
// ../../spec/config/tui-ux-plan.md Phase 3 ("Enhanced InputBar").
//
// ink-text-input doesn't expose ghost-suffix rendering, so the text field is hand-rolled here
// with useInput + manual cursor/text state (mirroring ink-text-input's own left/right/backspace
// handling for familiarity — see node_modules/ink-text-input/build/index.js).

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { UserInfo } from "../../client/UserList.js";
import { InputUserStatus } from "./StatusBar.js";
import { getCompletions, type CompletionEngineContext } from "../completion/engine.js";

export interface CommandInputProps {
  onSubmit: (value: string) => void;
  username: string;
  ready: boolean | null;
  powerUserMode: boolean;
  playlistFiles: string[];
  users: UserInfo[];
  settableKeys: string[];
  /** Whether the input currently owns keyboard focus. When false, a dim hint is shown instead. */
  active?: boolean;
  /** Panel-specific key hint shown in place of the input when `active` is false. */
  hint?: string;
  /** Live suggestion list for a chat overlay (shown when more than one match). */
  onSuggestionsChange?: (state: { items: string[]; selectedIndex: number | null } | null) => void;
}

interface TabSession {
  replaceFrom: number;
  candidates: string[];
  index: number;
}

interface SuggestionBrowse {
  savedValue: string;
  savedCursor: number;
  replaceFrom: number;
}

const MAX_HISTORY = 200;

interface HistoryBrowse {
  prefix: string;
  savedLine: string;
  index: number;
}

function filterHistory(history: readonly string[], prefix: string): string[] {
  return history.filter((entry) => entry.startsWith(prefix));
}

function pushHistory(history: string[], entry: string): string[] {
  if (history[history.length - 1] === entry) return history;
  return [...history, entry].slice(-MAX_HISTORY);
}

function buildPreview(
  browse: SuggestionBrowse,
  suggestion: string,
): { value: string; cursor: number } {
  const value =
    browse.savedValue.slice(0, browse.replaceFrom) +
    suggestion +
    browse.savedValue.slice(browse.savedCursor);
  return { value, cursor: browse.replaceFrom + suggestion.length };
}

export function CommandInput({
  onSubmit,
  username,
  ready,
  powerUserMode,
  playlistFiles,
  users,
  settableKeys,
  active = true,
  hint = "panel mode — Ctrl+↓ for input",
  onSuggestionsChange,
}: CommandInputProps): React.JSX.Element {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [tabSession, setTabSession] = useState<TabSession | null>(null);
  const [suggestionBrowse, setSuggestionBrowse] = useState<SuggestionBrowse | null>(null);
  const [historyBrowse, setHistoryBrowse] = useState<HistoryBrowse | null>(null);
  const historyRef = useRef<string[]>([]);

  const engineCtx: CompletionEngineContext = useMemo(
    () => ({ powerUserMode, playlistFiles, users, settableKeys }),
    [powerUserMode, playlistFiles, users, settableKeys],
  );

  const completionLine = suggestionBrowse?.savedValue ?? value;
  const completionCursor = suggestionBrowse?.savedCursor ?? cursor;

  const completion = useMemo(
    () =>
      dismissed
        ? { suggestions: [] as string[], replaceFrom: completionCursor }
        : getCompletions(
            { line: completionLine, cursor: completionCursor },
            engineCtx,
          ),
    [dismissed, completionLine, completionCursor, engineCtx],
  );

  const suggestionCount = completion.suggestions.length;
  const overlaySelectedIndex = suggestionBrowse ? selectedIndex : null;
  const submitSuggestionIndex = suggestionBrowse ? selectedIndex : 0;
  const ghostSuggestion =
    suggestionCount > 0 ? completion.suggestions[0] : undefined;
  const currentToken = completionLine.slice(
    completion.replaceFrom,
    completionCursor,
  );
  const ghost =
    !suggestionBrowse &&
    !historyBrowse &&
    ghostSuggestion &&
    cursor === value.length &&
    ghostSuggestion.length > currentToken.length &&
    ghostSuggestion.startsWith(currentToken)
      ? ghostSuggestion.slice(currentToken.length)
      : "";

  const onSuggestionsChangeRef = useRef(onSuggestionsChange);
  onSuggestionsChangeRef.current = onSuggestionsChange;
  const lastNotifiedSuggestionsRef = useRef<string | null>(null);

  useEffect(() => {
    const notify = onSuggestionsChangeRef.current;
    if (!notify) return;

    const payload =
      !active || historyBrowse || suggestionCount <= 1
        ? null
        : {
            items: completion.suggestions,
            selectedIndex: overlaySelectedIndex,
          };

    const key =
      payload === null
        ? ""
        : `${overlaySelectedIndex ?? "none"}\0${completion.suggestions.join("\0")}`;

    if (lastNotifiedSuggestionsRef.current === key) return;
    lastNotifiedSuggestionsRef.current = key;
    notify(payload);
  }, [
    active,
    historyBrowse,
    suggestionCount,
    completion.suggestions,
    overlaySelectedIndex,
  ]);

  useEffect(() => {
    return () => {
      lastNotifiedSuggestionsRef.current = null;
      onSuggestionsChangeRef.current?.(null);
    };
  }, []);

  const clearSuggestionState = (): void => {
    setSelectedIndex(0);
    setDismissed(false);
    setTabSession(null);
    setSuggestionBrowse(null);
  };

  const exitSuggestionBrowse = (): SuggestionBrowse | null => {
    const browse = suggestionBrowse;
    if (browse) {
      setValue(browse.savedValue);
      setCursor(browse.savedCursor);
      setSelectedIndex(0);
      setSuggestionBrowse(null);
    }
    return browse;
  };

  const applySuggestionPreview = (
    index: number,
    browse: SuggestionBrowse,
    suggestions: readonly string[],
  ): void => {
    const suggestion = suggestions[index];
    if (!suggestion) return;
    const preview = buildPreview(browse, suggestion);
    setValue(preview.value);
    setCursor(preview.cursor);
    setSelectedIndex(index);
  };

  const enterSuggestionBrowse = (
    direction: "up" | "down",
    suggestions: readonly string[],
    replaceFrom: number,
  ): void => {
    const browse: SuggestionBrowse = {
      savedValue: value,
      savedCursor: cursor,
      replaceFrom,
    };
    const initialIndex = direction === "down" ? 0 : suggestions.length - 1;
    setSuggestionBrowse(browse);
    applySuggestionPreview(initialIndex, browse, suggestions);
  };

  const navigateSuggestions = (direction: "up" | "down"): void => {
    if (suggestionCount <= 1) return;

    if (!suggestionBrowse) {
      enterSuggestionBrowse(direction, completion.suggestions, completion.replaceFrom);
      return;
    }

    if (direction === "up") {
      if (selectedIndex === 0) {
        exitSuggestionBrowse();
        return;
      }
      applySuggestionPreview(
        selectedIndex - 1,
        suggestionBrowse,
        completion.suggestions,
      );
      return;
    }

    const nextIndex =
      selectedIndex >= suggestionCount - 1 ? 0 : selectedIndex + 1;
    applySuggestionPreview(nextIndex, suggestionBrowse, completion.suggestions);
  };

  const applySelectedSuggestion = (): string => {
    const suggestion = completion.suggestions[submitSuggestionIndex];
    if (!suggestion || suggestionCount === 0) return value;
    const base = suggestionBrowse ?? {
      savedValue: value,
      savedCursor: cursor,
      replaceFrom: completion.replaceFrom,
    };
    return buildPreview(base, suggestion).value;
  };

  const acceptHighlightedSuggestion = (): void => {
    if (!suggestionBrowse) return;
    exitHistoryBrowse();
    setSuggestionBrowse(null);
    setSelectedIndex(0);
    setDismissed(false);
    setTabSession(null);
    // value/cursor already hold the previewed completion; drop browse so
    // completions recompute from the committed line (zsh menu-select accept).
  };

  const exitHistoryBrowse = (): void => {
    setHistoryBrowse(null);
  };

  const applyHistoryEntry = (entry: string): void => {
    exitSuggestionBrowse();
    setValue(entry);
    setCursor(entry.length);
    setSelectedIndex(0);
    setDismissed(false);
    setTabSession(null);
    setSuggestionBrowse(null);
  };

  const navigateHistory = (direction: "up" | "down"): boolean => {
    const browse = historyBrowse;
    const prefix = browse?.prefix ?? (suggestionBrowse?.savedValue ?? value);
    const filtered = filterHistory(historyRef.current, prefix);
    if (filtered.length === 0) return false;

    if (direction === "up") {
      if (!browse) {
        setHistoryBrowse({
          prefix,
          savedLine: suggestionBrowse?.savedValue ?? value,
          index: filtered.length - 1,
        });
        applyHistoryEntry(filtered[filtered.length - 1]!);
        return true;
      }
      const nextIndex = Math.max(0, browse.index - 1);
      setHistoryBrowse({ ...browse, index: nextIndex });
      applyHistoryEntry(filtered[nextIndex]!);
      return true;
    }

    if (!browse) return false;
    const nextIndex = browse.index + 1;
    if (nextIndex >= filtered.length) {
      setHistoryBrowse(null);
      applyHistoryEntry(browse.savedLine);
      return true;
    }
    setHistoryBrowse({ ...browse, index: nextIndex });
    applyHistoryEntry(filtered[nextIndex]!);
    return true;
  };

  const hasActiveAutosuggest = !dismissed && suggestionCount > 0;

  const editingBase = (): { value: string; cursor: number } => {
    if (suggestionBrowse) {
      return {
        value: suggestionBrowse.savedValue,
        cursor: suggestionBrowse.savedCursor,
      };
    }
    return { value, cursor };
  };

  useInput((input, key) => {
    if (key.escape) {
      exitSuggestionBrowse();
      if (historyBrowse) {
        setValue(historyBrowse.savedLine);
        setCursor(historyBrowse.savedLine.length);
        setHistoryBrowse(null);
      }
      setDismissed(true);
      return;
    }

    if (key.return) {
      const submitted =
        !historyBrowse && !dismissed && suggestionCount > 0
          ? applySelectedSuggestion()
          : value;
      onSubmit(submitted);
      if (submitted) {
        historyRef.current = pushHistory(historyRef.current, submitted);
      }
      setHistoryBrowse(null);
      setValue("");
      setCursor(0);
      clearSuggestionState();
      return;
    }

    if (key.tab) {
      exitHistoryBrowse();
      const base = editingBase();
      if (suggestionBrowse) {
        setValue(base.value);
        setCursor(base.cursor);
        setSuggestionBrowse(null);
      }
      if (tabSession && tabSession.candidates.length > 0) {
        const nextIndex = (tabSession.index + 1) % tabSession.candidates.length;
        const candidate = tabSession.candidates[nextIndex]!;
        const newValue =
          base.value.slice(0, tabSession.replaceFrom) +
          candidate +
          base.value.slice(base.cursor);
        setValue(newValue);
        setCursor(tabSession.replaceFrom + candidate.length);
        setTabSession({ ...tabSession, index: nextIndex });
        return;
      }
      const fresh = getCompletions(
        { line: base.value, cursor: base.cursor },
        engineCtx,
      );
      if (fresh.suggestions.length > 0) {
        const candidate = fresh.suggestions[0]!;
        const newValue =
          base.value.slice(0, fresh.replaceFrom) +
          candidate +
          base.value.slice(base.cursor);
        setValue(newValue);
        setCursor(fresh.replaceFrom + candidate.length);
        setTabSession({
          replaceFrom: fresh.replaceFrom,
          candidates: fresh.suggestions,
          index: 0,
        });
      }
      setDismissed(false);
      return;
    }

    if (tabSession) setTabSession(null);

    if (key.upArrow || key.downArrow) {
      const direction = key.upArrow ? "up" : "down";
      if (historyBrowse) {
        navigateHistory(direction);
        return;
      }
      if (hasActiveAutosuggest) {
        if (suggestionCount > 1) {
          navigateSuggestions(direction);
        }
        return;
      }
      navigateHistory(direction);
      return;
    }

    if (key.rightArrow || key.leftArrow) {
      if (suggestionBrowse) {
        acceptHighlightedSuggestion();
        return;
      }
      if (key.rightArrow) {
        if (cursor === value.length && ghost && ghostSuggestion) {
          exitHistoryBrowse();
          const preview = buildPreview(
            {
              savedValue: value,
              savedCursor: cursor,
              replaceFrom: completion.replaceFrom,
            },
            ghostSuggestion,
          );
          setValue(preview.value);
          setCursor(preview.cursor);
          clearSuggestionState();
          return;
        }
        setCursor((c) => Math.min(value.length, c + 1));
        return;
      }
      setCursor((c) => Math.max(0, c - 1));
      return;
    }

    if (key.backspace || key.delete) {
      const base = editingBase();
      if (suggestionBrowse) {
        setValue(base.value);
        setCursor(base.cursor);
        setSuggestionBrowse(null);
        setSelectedIndex(0);
      }
      if (base.cursor > 0) {
        exitHistoryBrowse();
        const newValue =
          base.value.slice(0, base.cursor - 1) + base.value.slice(base.cursor);
        setValue(newValue);
        setCursor(base.cursor - 1);
        setDismissed(false);
        setTabSession(null);
      }
      return;
    }

    if (key.ctrl || key.meta) {
      return;
    }

    if (input) {
      exitHistoryBrowse();
      const base = editingBase();
      if (suggestionBrowse) {
        setSuggestionBrowse(null);
        setSelectedIndex(0);
      }
      const newValue =
        base.value.slice(0, base.cursor) + input + base.value.slice(base.cursor);
      setValue(newValue);
      setCursor(base.cursor + input.length);
      setDismissed(false);
      setTabSession(null);
    }
  }, { isActive: active });

  const before = value.slice(0, cursor);
  const after = cursor < value.length ? value.slice(cursor + 1) : "";
  const cursorAtEnd = cursor >= value.length;

  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      width="100%"
      justifyContent="space-between"
    >
      <Box flexGrow={1} minWidth={0}>
        <Text color="cyan">{"> "}</Text>
        {active ? (
          <>
            <Text>{before}</Text>
            {cursorAtEnd ? (
              ghost ? (
                <>
                  <Text inverse>{ghost[0]}</Text>
                  {ghost.length > 1 ? (
                    <Text dimColor>{ghost.slice(1)}</Text>
                  ) : null}
                </>
              ) : (
                <Text inverse> </Text>
              )
            ) : (
              <>
                <Text inverse>{value[cursor]}</Text>
                <Text>{after}</Text>
              </>
            )}
          </>
        ) : (
          <Text dimColor>({hint})</Text>
        )}
      </Box>
      <InputUserStatus username={username} ready={ready} />
    </Box>
  );
}
