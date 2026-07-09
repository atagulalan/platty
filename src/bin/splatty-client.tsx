#!/usr/bin/env node
// CLI entry point for Splatty — a Syncplay-compatible terminal client.
// Config is stored in ~/.config/splatty/splatty.ini (Syncplay-compatible INI schema).

import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { userInfo } from "node:os";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SplattyApp, createClient } from "../tui/SplattyApp.js";
import type { SyncplayClient } from "../client/SyncplayClient.js";
import { createPlayer, type PlayerKind } from "../players/playerFactory.js";
import { NullPlayer } from "../players/NullPlayer.js";
import { checkPlayerAvailable } from "../players/checkPlayerAvailable.js";
import { DEFAULT_CLIENT_HOST, DEFAULT_CLIENT_PORT } from "../protocol/constants.js";
import {
  loadConfig,
  loadDirectoryConfigChain,
  mergeConfig,
  needsSetup,
  getConfigPath,
  type CliOverrides,
} from "../config/store.js";
import type { SplattyConfig } from "../config/types.js";
import type { Player } from "../players/BasePlayer.js";
import { isURL } from "../client/mediaUtils.js";

function defaultUsername(): string {
  try {
    const name = userInfo().username;
    if (name) return name;
  } catch {
    /* os.userInfo() can throw */
  }
  return `user${randomBytes(4).toString("hex")}`;
}

function readPackageVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const program = new Command();
program
  .name("splatty")
  .description("Splatty — Syncplay-compatible watch-together client (terminal UI)")
  .option("-a, --host <host>", "server address")
  .option("--port <port>", "server port")
  .option("-n, --name <username>", "your username")
  .option("-r, --room <room>", "room to join")
  .option("-p, --password <password>", "server password")
  .option("--player <kind>", "mpv | vlc | null")
  .option("--player-path <path>", "path to the player executable")
  .option("--setup", "run the setup wizard on launch")
  .option("--no-gui", "run without the terminal UI (headless)")
  .option("-d, --debug", "enable verbose debug logging")
  .option("-g, --force-gui-prompt", "always show the setup wizard on launch")
  .option("--no-store", "don't write config changes to disk this run")
  .option("--clear-gui-data", "delete the stored config file before starting")
  .option("-v, --version", "print the version and exit")
  .option("--language <code>", "UI language code (e.g. de, en, tr)")
  .option("--load-playlist-from-file <path>", "seed the playlist from a file, one entry per line")
  .argument("[file]", "media file or URL to open")
  .argument(
    "[playerArgs...]",
    "extra arguments passed through to the player (prefix with -- if they start with -)",
  )
  .parse(process.argv);

const opts = program.opts();

// Per spec/config/cli-and-settings-reference.md: -v/--version prints and exits immediately,
// before any other config/GUI/ini processing.
if (opts.version) {
  console.log(readPackageVersion());
  process.exit(0);
}

const [file, playerArgs] = program.processedArgs as [string | undefined, string[]];

if (opts.clearGuiData) {
  const path = getConfigPath();
  if (existsSync(path)) unlinkSync(path);
}

const cliOverrides: CliOverrides = {
  host: opts.host,
  port: opts.port !== undefined ? Number(opts.port) : undefined,
  name: opts.name,
  room: opts.room,
  password: opts.password,
  // config's PlayerKind covers every real (non-stub) player: mpv/vlc/null plus the mpv-family
  // variants. mplayer/mpc-hc/mpc-be are deliberately excluded (playerFactory.ts stubs them with
  // a hard error) so they're CLI-only via makePlayer() below, never persisted as a saved setting.
  playerKind: opts.player as SplattyConfig["playerKind"] | undefined,
  playerPath: opts.playerPath,
  forceSetup: opts.setup,
  forceGuiPrompt: opts.forceGuiPrompt,
  language: opts.language,
};

const loaded = loadConfig(defaultUsername());
let config: SplattyConfig = mergeConfig(loaded, cliOverrides);

// Per-directory `.syncplay` walk, applied at the highest precedence of all (see
// spec/config/resolution-and-precedence.md ~lines 31-49) — only meaningful for local files, not URLs.
if (file && !isURL(file)) {
  const dirChain = loadDirectoryConfigChain(file);
  config = { ...config, ...dirChain };
}

if (!config.name) config.name = defaultUsername();

if (opts.setup) config.setupComplete = false;
let showWizard = needsSetup(config) || opts.setup || config.forceGuiPrompt;
let playerStartupError: string | undefined;
if (!showWizard) {
  const availability = await checkPlayerAvailable(config.playerKind, config.playerPath);
  if (!availability.ok) {
    playerStartupError = availability.message;
    showWizard = true;
  }
}

function makePlayer(cfg: SplattyConfig): Player {
  const kind = cfg.playerKind ?? (opts.player as PlayerKind) ?? "mpv";
  const path = cfg.playerPath || undefined;
  return createPlayer(kind, path, cfg);
}

// During first-run setup (or missing player), use a headless stub until the wizard finishes.
const player: Player = showWizard ? new NullPlayer() : makePlayer(config);
const client = createClient(config, player);
const autoStart = !showWizard;

if (autoStart && opts.loadPlaylistFromFile) {
  try {
    const lines = readFileSync(opts.loadPlaylistFromFile, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) client.addToPlaylist(line);
  } catch (err) {
    client.emit(
      "log",
      `Could not load playlist from "${opts.loadPlaylistFromFile}": ${String(err)}`,
    );
  }
}

if (opts.debug) {
  client.emit(
    "log",
    `[debug] host=${config.host} port=${config.port} room=${config.room} player=${config.playerKind} file=${file ?? "(none)"} playerArgs=${JSON.stringify(playerArgs)}`,
  );
}

let exiting = false;
let unmountInk: (() => void) | undefined;
// Reconnect/wizard swap in a new SyncplayClient + player; SIGINT/waitUntilExit must stop that one.
let activeClient = client;

function registerActiveClient(next: SyncplayClient): void {
  activeClient = next;
}

function gracefulExit(): void {
  if (exiting) return;
  exiting = true;
  activeClient.stop();
  unmountInk?.();
}

const { unmount, waitUntilExit } = render(
  <SplattyApp
    config={config}
    client={client}
    createPlayer={makePlayer}
    initialFile={file}
    onExit={gracefulExit}
    onReconnect={(cfg, p) => createClient(cfg, p)}
    registerActiveClient={registerActiveClient}
    noStore={opts.store === false}
    debug={!!opts.debug}
    playerStartupError={playerStartupError}
    autoStart={autoStart}
  />,
);
unmountInk = unmount;

process.on("SIGINT", gracefulExit);
process.on("SIGTERM", gracefulExit);

void waitUntilExit().then(() => {
  gracefulExit();
  process.exit(0);
});
