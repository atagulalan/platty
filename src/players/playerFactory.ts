// See ../../spec/players/abstraction-and-selection.md#player-selection.

import type { SplattyConfig } from "../config/types.js";
import { syncplayIntfFromConfig } from "../config/toSyncplayIntfConfig.js";
import type { Player } from "./BasePlayer.js";
import { MpvPlayer } from "./mpvPlayer.js";
import { VlcPlayer } from "./vlcPlayer.js";
import { NullPlayer } from "./NullPlayer.js";

export type PlayerKind =
  "mpv" | "vlc" | "null" | "mpvnet" | "iina" | "memento" | "mplayer" | "mpc-hc" | "mpc-be";

export function createPlayer(
  kind: PlayerKind,
  executablePath?: string,
  config?: SplattyConfig,
): Player {
  const syncplayIntf = config ? syncplayIntfFromConfig(config) : undefined;

  switch (kind) {
    case "mpv":
      return new MpvPlayer(executablePath ?? "mpv", { syncplayIntf });
    case "vlc":
      return new VlcPlayer(executablePath ?? "vlc");
    case "null":
      return new NullPlayer();
    case "mpvnet":
      return new MpvPlayer(executablePath ?? "mpvnet", {
        extraArgs: ["--auto-load-folder=no"],
        skipVersionCheck: true,
        syncplayIntf,
      });
    case "iina":
      return new MpvPlayer(executablePath ?? "iina-cli", { skipVersionCheck: true, syncplayIntf });
    case "memento":
      return new MpvPlayer(executablePath ?? "memento", {
        skipVersionCheck: true,
        scriptArgName: "scripts",
        syncplayIntf,
      });
    case "mplayer":
      throw new Error("mplayer is not supported in this build; use mpv instead");
    case "mpc-hc":
    case "mpc-be":
      throw new Error(
        `${kind === "mpc-hc" ? "MPC-HC" : "MPC-BE"} is not supported in this build (it requires Windows-only WM_COPYDATA IPC); use mpv or VLC instead`,
      );
  }
}
