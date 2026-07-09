import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { SplattyConfig } from "../config/types.js";
import { DEFAULT_CLIENT_PORT } from "../protocol/constants.js";
import { checkPlayerAvailable, isPlayerFilesystemPath } from "../players/checkPlayerAvailable.js";

export interface SetupWizardProps {
  config: SplattyConfig;
  onComplete: (config: SplattyConfig) => void;
  onCancel?: () => void;
  initialError?: string;
  /** Jump to this step on open (e.g. when startup detects a missing player). */
  initialStepKey?: keyof SplattyConfig;
}

interface Step {
  key: keyof SplattyConfig | "done";
  label: string;
  hint: string;
  optional?: boolean;
  skip?: (config: SplattyConfig) => boolean;
  parse?: (raw: string, config: SplattyConfig) => Partial<SplattyConfig>;
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
    hint: "Comma-separated paths where Splatty searches for media files",
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
    hint: "mpv, vlc, null — or paste the full path to the player executable",
    parse: (raw, config) => {
      const trimmed = raw.trim();
      if (isPlayerFilesystemPath(trimmed)) {
        const lower = trimmed.toLowerCase();
        const playerKind: SplattyConfig["playerKind"] = lower.includes("vlc") ? "vlc" : "mpv";
        return { playerKind, playerPath: trimmed };
      }
      const kind = trimmed.toLowerCase() as SplattyConfig["playerKind"];
      const playerKind = kind === "vlc" || kind === "null" ? kind : "mpv";
      return {
        playerKind,
        playerPath: playerKind === "null" ? "" : config.playerPath || playerKind,
      };
    },
  },
  {
    key: "playerPath",
    label: "Player path",
    hint: "Executable path or command on PATH (Enter for default)",
    optional: true,
    skip: (config) =>
      config.playerKind === "null" || isPlayerFilesystemPath(config.playerPath),
    parse: (raw, config) => ({
      playerPath: raw.trim() || config.playerKind,
    }),
  },
];

function getStepValue(config: SplattyConfig, step: Step): string {
  const v = config[step.key as keyof SplattyConfig];
  if (step.key === "playerPath" && config.playerKind !== "null" && v === config.playerKind) {
    return "";
  }
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "number") return String(v);
  return String(v ?? "");
}

function nextStepIndex(from: number, config: SplattyConfig): number {
  let i = from + 1;
  while (i < STEPS.length && STEPS[i]?.skip?.(config)) i++;
  return i;
}

export function SetupWizard({
  config,
  onComplete,
  onCancel,
  initialError,
  initialStepKey,
}: SetupWizardProps): React.JSX.Element {
  const initialStepIndex = initialStepKey
    ? Math.max(
        0,
        STEPS.findIndex((step) => step.key === initialStepKey),
      )
    : 0;
  const [draft, setDraft] = useState<SplattyConfig>({ ...config });
  const [stepIndex, setStepIndex] = useState(initialStepIndex);
  const [value, setValue] = useState(getStepValue(draft, STEPS[initialStepIndex]!));
  const [error, setError] = useState(initialError ?? "");
  const [checking, setChecking] = useState(false);

  const step = STEPS[stepIndex];

  useInput((_input, key) => {
    if (checking) return;
    if (key.escape && onCancel) onCancel();
  });

  const advance = (raw: string): void => {
    if (checking || !step) return;
    const trimmed = raw.trim();
    if (!trimmed && !step.optional) return;

    let patch: Partial<SplattyConfig> = {};
    if (step.parse) {
      patch = step.parse(trimmed, draft);
    } else if (step.key !== "done") {
      patch = { [step.key]: trimmed };
    }

    const next = { ...draft, ...patch };
    setDraft(next);

    void (async () => {
      const nextIndex = nextStepIndex(stepIndex, next);
      const atEnd = nextIndex >= STEPS.length;

      const enteredPathOnPlayerStep =
        step.key === "playerKind" && isPlayerFilesystemPath(trimmed);
      const onPlayerPathStep = step.key === "playerPath";
      const needsPlayerCheck =
        (enteredPathOnPlayerStep || onPlayerPathStep || atEnd) && next.playerKind !== "null";
      if (needsPlayerCheck) {
        setChecking(true);
        const result = await checkPlayerAvailable(next.playerKind, next.playerPath);
        setChecking(false);
        if (!result.ok) {
          setError(result.message);
          return;
        }
      }

      setError("");

      if (atEnd) {
        onComplete({ ...next, setupComplete: true, forceGuiPrompt: false });
        return;
      }

      const nextStep = STEPS[nextIndex];
      if (!nextStep) return;
      setStepIndex(nextIndex);
      setValue(getStepValue(next, nextStep));
    })();
  };

  if (!step) return <Text color="red">Setup error: invalid step.</Text>;

  return (
    <Box flexDirection="column" padding={1} borderStyle="double" borderColor="cyan">
      <Text bold color="cyan">
        Splatty Setup ({stepIndex + 1}/{STEPS.length})
      </Text>
      <Text dimColor>
        {step.optional ? "(optional) " : ""}
        {step.hint}
      </Text>
      <Box marginTop={1}>
        <Text color="yellow">{step.label}: </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={advance}
          placeholder={step.optional ? "Enter to skip" : undefined}
        />
      </Box>
      {error ? (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>
          {checking ? "Checking player…" : "Enter to continue · Esc to cancel"}
        </Text>
      </Box>
    </Box>
  );
}
