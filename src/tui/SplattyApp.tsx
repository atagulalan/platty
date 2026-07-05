import React, { useCallback, useEffect, useState } from "react";
import { Box, Text } from "ink";
import { SyncplayClient } from "../client/SyncplayClient.js";
import type { Player } from "../players/BasePlayer.js";
import type { SplattyConfig } from "../config/types.js";
import { saveConfig } from "../config/store.js";
import { configToClientOptions } from "../config/toClientOptions.js";
import { setConfigValue } from "../config/setValue.js";
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
}: SplattyAppProps): React.JSX.Element {
  const [config, setConfig] = useState<SplattyConfig>(initialConfig);
  const [client, setClient] = useState<SyncplayClient>(initialClient);
  // forceGuiPrompt forces the wizard on launch even if setup was already completed (see
  // ts/src/config/types.ts's forceGuiPrompt and spec/config/ui-and-commands.md's "Misc" tab).
  const [view, setView] = useState<SplattyView>(
    initialConfig.setupComplete && !initialConfig.forceGuiPrompt ? "main" : "wizard",
  );

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
    (next: SplattyConfig, file?: string): void => {
      client.stop();
      const player = createPlayer(next);
      const nextClient = onReconnect(next, player);
      registerActiveClient?.(nextClient);
      setClient(nextClient);
      if (file) void player.open(file);
      void nextClient.start();
    },
    [client, createPlayer, onReconnect, registerActiveClient],
  );

  const handleWizardComplete = useCallback(
    (next: SplattyConfig): void => {
      persist(next);
      setView("main");
      reconnect(next, initialFile);
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
        if (result.reconnect) reconnect(next);
      }
      return result.message;
    },
    [config, persist, reconnect],
  );

  const handleSettingsSave = useCallback(
    (next: SplattyConfig): void => {
      persist(next);
      reconnect(next);
      setView("main");
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
