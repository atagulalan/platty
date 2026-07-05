import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { SplattyConfig, ConfigKey } from "../config/types.js";
import { CONFIG_FIELDS } from "../config/iniStructure.js";
import { formatConfigValue } from "../config/store.js";
import { setConfigValue } from "../config/setValue.js";

export interface SettingsPanelProps {
  config: SplattyConfig;
  onSave: (config: SplattyConfig) => void;
  onClose: () => void;
}

/** Max setting rows visible at once (keeps the panel from growing with long tabs). */
const MAX_VISIBLE_ROWS = 12;

function tabLabel(section: string): string {
  return section === "GUI (Syncplay)" ? "GUI" : section;
}

export function SettingsPanel({ config, onSave, onClose }: SettingsPanelProps): React.JSX.Element {
  const [draft, setDraft] = useState<SplattyConfig>({ ...config });
  const [activeTab, setActiveTab] = useState(0);
  const [selected, setSelected] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [message, setMessage] = useState("");

  const fields = CONFIG_FIELDS;
  const sections = useMemo(() => {
    const map = new Map<string, typeof fields>();
    for (const f of fields) {
      const list = map.get(f.section) ?? [];
      list.push(f);
      map.set(f.section, list);
    }
    return [...map.entries()];
  }, [fields]);

  const activeFields = sections[activeTab]?.[1] ?? [];
  const visibleFields = activeFields.slice(scrollTop, scrollTop + MAX_VISIBLE_ROWS);
  const hasMoreAbove = scrollTop > 0;
  const hasMoreBelow = scrollTop + MAX_VISIBLE_ROWS < activeFields.length;

  useEffect(() => {
    setSelected(0);
    setScrollTop(0);
  }, [activeTab]);

  useEffect(() => {
    setScrollTop((top) => {
      if (selected < top) return selected;
      if (selected >= top + MAX_VISIBLE_ROWS) return selected - MAX_VISIBLE_ROWS + 1;
      return top;
    });
  }, [selected]);

  useInput((input, key) => {
    if (editing) return;
    if (key.escape || input === "q") onClose();
    if (key.leftArrow || input === "h") {
      setActiveTab((t) => Math.max(0, t - 1));
      return;
    }
    if (key.rightArrow || input === "l") {
      setActiveTab((t) => Math.min(sections.length - 1, t + 1));
      return;
    }
    if (key.upArrow || input === "k") setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow || input === "j")
      setSelected((s) => Math.min(activeFields.length - 1, s + 1));
    if (key.return) {
      const field = activeFields[selected];
      if (!field) return;
      setEditValue(formatConfigValue(field.key, draft[field.key]));
      setEditing(true);
      setMessage("");
    }
    if (input === "s" && (key.ctrl || key.meta)) {
      onSave({ ...draft });
      setMessage("Saved.");
    }
  });

  const commitEdit = (raw: string): void => {
    const field = activeFields[selected];
    if (!field) {
      setEditing(false);
      return;
    }
    const result = setConfigValue(draft, field.key, raw);
    setMessage(result.message);
    setEditing(false);
  };

  const [activeSection] = sections[activeTab] ?? ["", []];

  return (
    <Box flexDirection="column" padding={1} borderStyle="double" borderColor="magenta">
      <Text bold color="magenta">
        Splatty Settings
      </Text>
      <Text dimColor>←/→ or h/l tab · ↑/↓ or j/k field · Enter edit · Ctrl+S save · Esc close</Text>
      {message ? <Text color="green">{message}</Text> : null}

      <Box flexDirection="row" flexWrap="wrap" marginTop={1} gap={1}>
        {sections.map(([section], idx) => {
          const active = idx === activeTab && !editing;
          return (
            <Text key={section} color={active ? "cyan" : "gray"} bold={active}>
              {active ? `[${tabLabel(section)}]` : tabLabel(section)}
            </Text>
          );
        })}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold underline>
          {activeSection} ({activeTab + 1}/{sections.length})
        </Text>
        {hasMoreAbove ? <Text dimColor>↑ {scrollTop} more above</Text> : null}
        {visibleFields.map((field, visIdx) => {
          const idx = scrollTop + visIdx;
          const active = idx === selected && !editing;
          return (
            <Box key={field.key}>
              <Text color={active ? "cyan" : undefined}>
                {active ? "▸ " : "  "}
                {field.label}: {formatConfigValue(field.key, draft[field.key as ConfigKey])}
              </Text>
            </Box>
          );
        })}
        {hasMoreBelow ? (
          <Text dimColor>↓ {activeFields.length - scrollTop - MAX_VISIBLE_ROWS} more below</Text>
        ) : null}
      </Box>

      {editing ? (
        <Box marginTop={1}>
          <Text color="yellow">New value: </Text>
          <TextInput value={editValue} onChange={setEditValue} onSubmit={commitEdit} />
        </Box>
      ) : null}
    </Box>
  );
}
