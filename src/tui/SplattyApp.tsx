import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import { SyncplayClient } from "../client/SyncplayClient.js";
import type { Player } from "../players/BasePlayer.js";
import type { SplattyConfig } from "../config/types.js";
import { saveConfig } from "../config/store.js";
import { configToClientOptions } from "../config/toClientOptions.js";
import { setConfigValue } from "../config/setValue.js";
import { checkPlayerAvailable } from "../players/checkPlayerAvailable.js";
import { App } from "./App.js";
import { SetupWizard } from "./SetupWizard.js";
import { SettingsPanel } from "./SettingsPanel.js";

export type SplattyView = "main" | "wizard" | "settings";

export interface SplattyAppProps {
  config: SplattyConfig;
  client: SyncplayClient;
  createPlayer: (config: SplattyConfig) => Player;
  initialFile?: string;
  onExit: () => void;
  onReconnect: (config: SplattyConfig, player: Player) => SyncplayClient;
  /** Keep SIGINT/waitUntilExit cleanup in sync after reconnect/wizard swaps the client. */
  registerActiveClient?: (client: SyncplayClient) => void;
  /** --no-store: skip persisting config changes to disk for this run. */
  noStore?: boolean;
  /** --debug: surface extra internal state-change lines in the log. */
  debug?: boolean;
  /** Shown on the setup wizard when the configured player is missing at startup. */
  playerStartupError?: string;
  /** When true, SplattyApp starts the player and Syncplay connection after mount. */
  autoStart?: boolean;
}

export function SplattyApp({
  config: initialConfig,
  client: initialClient,
  createPlayer,
  initialFile,
  onExit,
  onReconnect,
  registerActiveClient,
  noStore,
  debug,
  playerStartupError,
  autoStart = false,
}: SplattyAppProps): React.JSX.Element {
  const [config, setConfig] = useState<SplattyConfig>(initialConfig);
  const [client, setClient] = useState<SyncplayClient>(initialClient);
  const [playerError, setPlayerError] = useState(playerStartupError ?? "");
  // forceGuiPrompt forces the wizard on launch even if setup was already completed (see
  // ts/src/config/types.ts's forceGuiPrompt and spec/config/ui-and-commands.md's "Misc" tab).
  const [view, setView] = useState<SplattyView>(
    initialConfig.setupComplete && !initialConfig.forceGuiPrompt && !playerStartupError
      ? "main"
      : "wizard",
  );
  const startupDone = useRef(false);

  const persist = useCallback(
    (next: SplattyConfig): void => {
      if (!noStore) saveConfig(next);
      setConfig(next);
    },
    [noStore],
  );

  useEffect(() => {
    registerActiveClient?.(client);
  }, [client, registerActiveClient]);

  useEffect(() => {
    const handleShutdown = (): void => {
      onExit();
    };
    client.on("shutdown", handleShutdown);
    return () => {
      client.off("shutdown", handleShutdown);
    };
  }, [client, onExit]);

  const reconnect = useCallback(
    async (next: SplattyConfig, file?: string): Promise<string | null> => {
      const availability = await checkPlayerAvailable(next.playerKind, next.playerPath);
      if (!availability.ok) return availability.message;

      client.stop();
      const player = createPlayer(next);
      try {
        await player.open(file ?? "");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return message;
      }

      const nextClient = onReconnect(next, player);
      registerActiveClient?.(nextClient);
      setClient(nextClient);
      void nextClient.start();
      return null;
    },
    [client, createPlayer, onReconnect, registerActiveClient],
  );

  useEffect(() => {
    if (!autoStart || startupDone.current || view !== "main") return;
    startupDone.current = true;
    void reconnect(config, initialFile).then((message) => {
      if (message) {
        setPlayerError(message);
        setView("wizard");
      }
    });
  }, [autoStart, view, config, initialFile, reconnect]);

  const handleWizardComplete = useCallback(
    (next: SplattyConfig): void => {
      void reconnect(next, initialFile).then((message) => {
        if (message) {
          setPlayerError(message);
          setConfig(next);
          return;
        }
        setPlayerError("");
        persist(next);
        setView("main");
      });
    },
    [persist, reconnect, initialFile],
  );

  const handleWizardCancel = useCallback((): void => {
    if (config.setupComplete) setView("main");
    else onExit();
  }, [config.setupComplete, onExit]);

  const handleSet = useCallback(
    (key: string, value: string): string => {
      const next = { ...config };
      const result = setConfigValue(next, key, value);
      if (result.ok) {
        persist(next);
        if (result.reconnect) {
          void reconnect(next).then((message) => {
            if (message) {
              setPlayerError(message);
              setView("wizard");
            }
          });
        }
      }
      return result.message;
    },
    [config, persist, reconnect],
  );

  const handleSettingsSave = useCallback(
    (next: SplattyConfig): void => {
      void reconnect(next).then((message) => {
        if (message) {
          setPlayerError(message);
          setView("wizard");
          return;
        }
        persist(next);
        setView("main");
      });
    },
    [persist, reconnect],
  );

  if (view === "wizard") {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">
          Splatty
        </Text>
        <SetupWizard
          config={config}
          onComplete={handleWizardComplete}
          onCancel={handleWizardCancel}
          initialError={playerError || undefined}
          initialStepKey={playerError ? "playerKind" : undefined}
        />
      </Box>
    );
  }

  if (view === "settings") {
    return (
      <SettingsPanel config={config} onSave={handleSettingsSave} onClose={() => setView("main")} />
    );
  }

  return (
    <App
      client={client}
      host={config.host}
      port={config.port}
      defaultRoom={config.room}
      debug={debug}
      onSetup={() => setView("wizard")}
      onSettings={() => setView("settings")}
      onSet={handleSet}
      onExit={() => {
        client.stop();
        onExit();
      }}
    />
  );
}

export function createClient(config: SplattyConfig, player: Player): SyncplayClient {
  return new SyncplayClient(configToClientOptions(config), player);
}
