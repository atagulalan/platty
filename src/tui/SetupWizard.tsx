import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { PlattyConfig } from "../config/types.js";
import { DEFAULT_CLIENT_PORT } from "../protocol/constants.js";

export interface SetupWizardProps {
  config: PlattyConfig;
  onComplete: (config: PlattyConfig) => void;
  onCancel?: () => void;
}

interface Step {
  key: keyof PlattyConfig | "done";
  label: string;
  hint: string;
  optional?: boolean;
  parse?: (raw: string, config: PlattyConfig) => Partial<PlattyConfig>;
}

const STEPS: Step[] = [
  {
    key: "name",
    label: "Username",
    hint: "Your display name in the room",
  },
  {
    key: "host",
    label: "Server",
    hint: "Syncplay server hostname (e.g. syncplay.pl)",
  },
  {
    key: "port",
    label: "Port",
    hint: "Server port (e.g. 8998)",
    parse: (raw) => ({ port: Number(raw) || DEFAULT_CLIENT_PORT }),
  },
  {
    key: "room",
    label: "Room",
    hint: "Room name to join",
  },
  {
    key: "password",
    label: "Password",
    hint: "Server password (leave empty if none)",
    optional: true,
  },
  {
    key: "mediaSearchDirectories",
    label: "Media directories",
    hint: "Comma-separated paths where Platty searches for media files",
    optional: true,
    parse: (raw) => ({
      mediaSearchDirectories: raw
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean),
    }),
  },
  {
    key: "playerKind",
    label: "Player",
    hint: "mpv, vlc, or null (no player)",
    parse: (raw, config) => {
      const kind = raw.toLowerCase() as PlattyConfig["playerKind"];
      const playerKind = kind === "vlc" || kind === "null" ? kind : "mpv";
      return {
        playerKind,
        playerPath: playerKind === "null" ? "" : config.playerPath || playerKind,
      };
    },
  },
];

function getStepValue(config: PlattyConfig, step: Step): string {
  const v = config[step.key as keyof PlattyConfig];
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "number") return String(v);
  return String(v ?? "");
}

export function SetupWizard({ config, onComplete, onCancel }: SetupWizardProps): React.JSX.Element {
  const [draft, setDraft] = useState<PlattyConfig>({ ...config });
  const [stepIndex, setStepIndex] = useState(0);
  const [value, setValue] = useState(getStepValue(draft, STEPS[0]!));

  const step = STEPS[stepIndex]!;
  const isLast = stepIndex === STEPS.length - 1;

  useInput((_input, key) => {
    if (key.escape && onCancel) onCancel();
  });

  const advance = (raw: string): void => {
    const trimmed = raw.trim();
    if (!trimmed && !step.optional) return;

    let patch: Partial<PlattyConfig> = {};
    if (step.parse) {
      patch = step.parse(trimmed, draft);
    } else if (step.key !== "done") {
      patch = { [step.key]: trimmed };
    }

    const next = { ...draft, ...patch };
    setDraft(next);

    if (isLast) {
      onComplete({ ...next, setupComplete: true, forceGuiPrompt: false });
      return;
    }

    const nextStep = STEPS[stepIndex + 1]!;
    setStepIndex(stepIndex + 1);
    setValue(getStepValue(next, nextStep));
  };

  return (
    <Box flexDirection="column" padding={1} borderStyle="double" borderColor="cyan">
      <Text bold color="cyan">
        Platty Setup ({stepIndex + 1}/{STEPS.length})
      </Text>
      <Text dimColor>{step.optional ? "(optional) " : ""}{step.hint}</Text>
      <Box marginTop={1}>
        <Text color="yellow">{step.label}: </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={advance}
          placeholder={step.optional ? "Enter to skip" : undefined}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Enter to continue · Esc to cancel</Text>
      </Box>
    </Box>
  );
}
