// English notification strings — mirrors source/syncplay/messages_en.py keys used by the client OSD
// pipeline. Full i18n can plug in here later via config.language.

const en = {
  "connected-successful-notification": "Successfully connected to server",
  "reconnection-attempt-notification": "Connection with server lost, attempting to reconnect",
  "rewind-notification": "Rewinded due to time difference with {}",
  "fastforward-notification": "Fast-forwarded due to time difference with {}",
  "slowdown-notification": "Slowing down due to time difference with {}",
  "revert-notification": "Reverting speed back to normal",
  "pause-notification": "{} paused at {}",
  "unpause-notification": "{} unpaused",
  "seek-notification": "{} jumped from {} to {}",
  "room-join-notification": "{} has joined the room: '{}'",
  "left-notification": "{} has left",
  "left-paused-notification": "{} left, {} paused",
  "playing-notification": "{} is playing '{}' ({})",
  "playing-notification/room-addendum": " in room: '{}'",
  "set-as-ready-notification": "You are now set as ready",
  "set-as-not-ready-notification": "You are now set as not ready",
  "ready-to-unpause-notification": "You are now set as ready - unpause again to unpause",
  "all-users-ready": "Everyone is ready ({} users)",
  "autoplaying-notification": "Auto-playing in {}...",
  "authenticated-as-controller-notification": "{} authenticated as a room operator",
  "other-set-as-ready-notification": "{} was set as ready by {}",
  "other-set-as-not-ready-notification": "{} was set as not ready by {}",
  "file-differences-notification": "Your file differs in the following way(s): {}",
  "file-difference-filename": "name",
  "file-difference-filesize": "size",
  "file-difference-duration": "duration",
  "current-offset-notification": "Current offset: {} seconds",
  "mpv-key-tab-hint": "[TAB] to toggle access to alphabet row key shortcuts.",
  "mpv-key-hint": "[ENTER] to send message. [ESC] to escape chat mode.",
  "alphakey-mode-warning-first-line": "You can temporarily use old mpv bindings with a-z keys.",
  "alphakey-mode-warning-second-line": "Press [TAB] to return to Syncplay chat mode.",
} as const;

export type MessageKey = keyof typeof en;

export function getMessage(key: MessageKey): string {
  return en[key];
}

/** Mirrors messages.py isNoOSDMessage() for slowdown/revert strings. */
export function isNoOsdMessage(message: string): boolean {
  const patterns = [
    getMessage("slowdown-notification").replace("{}", ".+"),
    getMessage("revert-notification"),
  ];
  return patterns.some((pattern) => new RegExp(`^${pattern}$`).test(message));
}

export function formatMessage(template: string, ...args: (string | number)[]): string {
  let i = 0;
  return template.replace(/\{\}/g, () => String(args[i++] ?? ""));
}
