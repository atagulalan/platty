import type { SyncplayClientOptions } from "../client/SyncplayClient.js";
import type { PrivacyMode } from "../protocol/constants.js";
import type { PlattyConfig } from "./types.js";
import { osdSettingsFromConfig } from "./toSyncplayIntfConfig.js";

export function configToClientOptions(config: PlattyConfig): SyncplayClientOptions {
  return {
    host: config.host,
    port: config.port,
    username: config.name,
    password: config.password || undefined,
    room: config.room,
    readyAtStart: config.readyAtStart,
    mediaSearchDirectories: config.mediaSearchDirectories,
    sharedPlaylistEnabled: config.sharedPlaylistEnabled,
    onlySwitchToTrustedDomains: config.onlySwitchToTrustedDomains,
    trustedDomains: config.trustedDomains,
    osd: osdSettingsFromConfig(config),
    privacy: {
      filenameMode: config.filenamePrivacyMode as PrivacyMode,
      filesizeMode: config.filesizePrivacyMode as PrivacyMode,
    },
    syncConfig: {
      rewindThreshold: config.rewindThreshold,
      fastforwardThreshold: config.fastforwardThreshold,
      slowdownThreshold: config.slowdownThreshold,
      rewindOnDesync: config.rewindOnDesync,
      fastforwardOnDesync: config.fastforwardOnDesync,
      slowOnDesync: config.slowOnDesync,
      dontSlowDownWithMe: config.dontSlowDownWithMe,
    },
    unpauseAction: config.unpauseAction,
    autoplayInitialState: config.autoplayInitialState,
    autoplayMinUsers: config.autoplayMinUsers,
    autoplayRequireSameFilenames: config.autoplayRequireSameFilenames,
    pauseOnLeave: config.pauseOnLeave,
    loopAtEndOfPlaylist: config.loopAtEndOfPlaylist,
    loopSingleFiles: config.loopSingleFiles,
  };
}
