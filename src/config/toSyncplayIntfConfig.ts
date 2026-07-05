import type { SyncplayIntfConfig } from "../players/mpvSyncplayIntf.js";
import type { PlattyConfig } from "./types.js";

/** MAX_CHAT_MESSAGE_LENGTH from source/syncplay/constants.py */
const MAX_CHAT_MESSAGE_LENGTH = 150;

export function syncplayIntfFromConfig(config: PlattyConfig): SyncplayIntfConfig {
  return {
    chatInputEnabled: config.chatInputEnabled,
    chatInputFontFamily: config.chatInputFontFamily,
    chatInputRelativeFontSize: config.chatInputRelativeFontSize,
    chatInputFontWeight: config.chatInputFontWeight,
    chatInputFontUnderline: config.chatInputFontUnderline,
    chatInputFontColor: config.chatInputFontColor,
    chatInputPosition: config.chatInputPosition,
    chatOutputFontFamily: config.chatOutputFontFamily,
    chatOutputRelativeFontSize: config.chatOutputRelativeFontSize,
    chatOutputFontWeight: config.chatOutputFontWeight,
    chatOutputFontUnderline: config.chatOutputFontUnderline,
    chatOutputMode: config.chatOutputMode,
    chatMaxLines: config.chatMaxLines,
    chatTopMargin: config.chatTopMargin,
    chatLeftMargin: config.chatLeftMargin,
    chatBottomMargin: config.chatBottomMargin,
    chatDirectInput: config.chatDirectInput,
    notificationTimeout: config.notificationTimeout,
    alertTimeout: config.alertTimeout,
    chatTimeout: config.chatTimeout,
    chatOutputEnabled: config.chatOutputEnabled,
    chatMoveOSD: config.chatMoveOSD,
    chatOSDMargin: config.chatOSDMargin,
    maxChatMessageLength: MAX_CHAT_MESSAGE_LENGTH,
    oscVisibilityChangeCompatible: false,
  };
}

export function osdSettingsFromConfig(config: PlattyConfig) {
  return {
    showOSD: config.showOSD,
    showOSDWarnings: config.showOSDWarnings,
    showSlowdownOSD: config.showSlowdownOSD,
    showSameRoomOSD: config.showSameRoomOSD,
    showDifferentRoomOSD: config.showDifferentRoomOSD,
    showNonControllerOSD: config.showNonControllerOSD,
    chatOutputEnabled: config.chatOutputEnabled,
  };
}
