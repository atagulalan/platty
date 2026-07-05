// Mirrors source/syncplay/client.py SyncplayUIAdapter.showMessage / showOSDMessage / showChatMessage.

import type { Player } from "../players/BasePlayer.js";
import type { OsdMood, OsdType } from "../players/mpvSyncplayIntf.js";
import {
  NO_ALERT_OSD_WARNING_DURATION_S,
  OSD_DURATION_S,
  OSD_WARNING_MESSAGE_DURATION_S,
} from "../players/mpvSyncplayIntf.js";
import { formatMessage, getMessage, isNoOsdMessage } from "./messages.js";

export interface OsdSettings {
  showOSD: boolean;
  showOSDWarnings: boolean;
  showSlowdownOSD: boolean;
  showSameRoomOSD: boolean;
  showDifferentRoomOSD: boolean;
  showNonControllerOSD: boolean;
  chatOutputEnabled: boolean;
}

export interface ShowMessageOptions {
  /** When true, message goes to the TUI log only — not the player overlay. */
  hideFromPlayer?: boolean;
  /** When true, skip the TUI log line (player-only, e.g. autoplay countdown). */
  noLog?: boolean;
  osdType?: OsdType;
  mood?: OsdMood;
  duration?: number;
}

function hasChatOverlay(player: Player): player is Player & { displayChatMessage: (u: string, m: string) => void } {
  return typeof (player as { displayChatMessage?: unknown }).displayChatMessage === "function";
}

export class PlayerPresenter {
  private lastAlertOsdMessage = "";
  private lastAlertOsdEndTime = 0;
  private lastNotificationOsdMessage = "";
  private lastNotificationOsdEndTime = 0;

  /** Used for left-paused-notification timing (client.py lastLeftTime / lastLeftUser). */
  lastLeftTime = 0;
  lastLeftUser = "";

  constructor(
    private readonly player: Player,
    private readonly settings: OsdSettings,
    private readonly onLog: (message: string) => void,
    private readonly autoplayTimerRunning: () => boolean = () => false,
  ) {}

  showMessage(message: string, options: ShowMessageOptions = {}): void {
    if (!options.noLog) this.onLog(message);
    if (!options.hideFromPlayer) {
      this.showOsdMessage(message, {
        duration: options.duration,
        osdType: options.osdType,
        mood: options.mood,
      });
    }
  }

  showChatMessage(username: string, userMessage: string): void {
    const line = `<${username}> ${userMessage}`;
    this.onLog(line);
    if (hasChatOverlay(this.player) && this.settings.chatOutputEnabled) {
      this.player.displayChatMessage(username, userMessage);
    } else {
      this.showOsdMessage(line);
    }
  }

  showOsdMessage(
    message: string,
    options: { duration?: number; osdType?: OsdType; mood?: OsdMood } = {},
  ): void {
    if (isNoOsdMessage(message)) return;

    const osdType = options.osdType ?? "notification";
    const mood = options.mood ?? "neutral";
    const duration = options.duration ?? OSD_DURATION_S;

    if (osdType === "alert" && !this.settings.showOSDWarnings && !this.autoplayTimerRunning()) return;
    if (!this.settings.showOSD) return;

    let combined = message;
    const now = Date.now() / 1000;
    const alertSupported = this.player.alertOsdSupported !== false;

    if (!alertSupported) {
      if (osdType === "alert") {
        this.lastAlertOsdMessage = message;
        this.lastAlertOsdEndTime =
          now + (this.autoplayTimerRunning() ? 1.0 : NO_ALERT_OSD_WARNING_DURATION_S);
        if (this.lastNotificationOsdEndTime && now < this.lastNotificationOsdEndTime) {
          combined = `${message}${this.player.osdMessageSeparator ?? "; "}${this.lastNotificationOsdMessage}`;
        }
      } else {
        this.lastNotificationOsdMessage = message;
        this.lastNotificationOsdEndTime = now + duration;
        if (this.lastAlertOsdEndTime && now < this.lastAlertOsdEndTime) {
          combined = `${this.lastAlertOsdMessage}${this.player.osdMessageSeparator ?? "; "}${message}`;
        }
      }
    }

    this.player.displayMessage(combined, {
      duration,
      osdType,
      mood,
    });
  }

  recordUserLeft(username: string): void {
    this.lastLeftTime = Date.now() / 1000;
    this.lastLeftUser = username;
  }

  notifyConnected(): void {
    this.showMessage(getMessage("connected-successful-notification"));
  }

  notifyReconnecting(): void {
    this.showMessage(getMessage("reconnection-attempt-notification"));
  }

  notifyRewind(setBy: string): void {
    this.showMessage(formatMessage(getMessage("rewind-notification"), setBy), {
      hideFromPlayer: !this.settings.showSameRoomOSD,
    });
  }

  notifyFastForward(setBy: string): void {
    this.showMessage(formatMessage(getMessage("fastforward-notification"), setBy), {
      hideFromPlayer: !this.settings.showSameRoomOSD,
    });
  }

  notifySlowdown(setBy: string): void {
    this.showMessage(formatMessage(getMessage("slowdown-notification"), setBy), {
      hideFromPlayer: !this.settings.showSlowdownOSD,
    });
  }

  notifyRevert(): void {
    this.showMessage(getMessage("revert-notification"), {
      hideFromPlayer: !this.settings.showSlowdownOSD,
    });
  }

  notifyPaused(setBy: string | null, position: number, formatTime: (s: number) => string): void {
    const hideFromPlayer = !this.settings.showSameRoomOSD;
    const user = setBy ?? "?";
    if (
      this.lastLeftTime > Date.now() / 1000 - OSD_DURATION_S &&
      !hideFromPlayer &&
      this.lastLeftUser
    ) {
      this.showMessage(formatMessage(getMessage("left-paused-notification"), this.lastLeftUser, user), {
        hideFromPlayer,
      });
    } else {
      this.showMessage(formatMessage(getMessage("pause-notification"), user, formatTime(position)), {
        hideFromPlayer,
      });
    }
  }

  notifyUnpaused(setBy: string | null): void {
    this.showMessage(formatMessage(getMessage("unpause-notification"), setBy ?? "?"), {
      hideFromPlayer: !this.settings.showSameRoomOSD,
    });
  }

  notifySeek(
    setBy: string,
    fromSeconds: number,
    toSeconds: number,
    formatTime: (s: number) => string,
  ): void {
    this.showMessage(
      formatMessage(
        getMessage("seek-notification"),
        setBy,
        formatTime(fromSeconds),
        formatTime(toSeconds),
      ),
      { hideFromPlayer: !this.settings.showSameRoomOSD },
    );
  }

  shouldShowForRoom(userRoom: string, selfRoom: string, isController: boolean): boolean {
    if (!this.settings.showNonControllerOSD && !isController) return false;
    if (userRoom === selfRoom) return this.settings.showSameRoomOSD;
    return this.settings.showDifferentRoomOSD;
  }

  notifyUserJoined(
    username: string,
    room: string,
    file: { name: string; duration: number } | null,
    formatTimeFn: (s: number) => string,
    hideFromPlayer: boolean,
  ): void {
    if (!file) {
      this.showMessage(formatMessage(getMessage("room-join-notification"), username, room), {
        hideFromPlayer,
      });
      return;
    }
    let message = formatMessage(
      getMessage("playing-notification"),
      username,
      file.name,
      formatTimeFn(file.duration),
    );
    message += formatMessage(getMessage("playing-notification/room-addendum"), room);
    this.showMessage(message, { hideFromPlayer });
  }

  notifyUserLeft(username: string, hideFromPlayer: boolean): void {
    this.recordUserLeft(username);
    this.showMessage(formatMessage(getMessage("left-notification"), username), { hideFromPlayer });
  }

  notifyAutoplayCountdown(secondsLeft: number, readyCount: number): void {
    const allReadyMessage = formatMessage(getMessage("all-users-ready"), readyCount);
    const autoplayingMessage = formatMessage(getMessage("autoplaying-notification"), Math.trunc(secondsLeft));
    const separator = this.player.osdMessageSeparator ?? "; ";
    this.showOsdMessage(`${allReadyMessage}${separator}${autoplayingMessage}`, {
      duration: 1,
      osdType: "alert",
      mood: "good",
    });
  }

  notifyControllerAuth(username: string, selfUsername: string, success: boolean): void {
    if (!success || username !== selfUsername) return;
    this.showMessage(formatMessage(getMessage("authenticated-as-controller-notification"), username), {
      hideFromPlayer: !this.settings.showSameRoomOSD,
    });
  }

  notifyReadyChange(username: string, isReady: boolean, setBy: string | undefined, selfUsername: string): void {
    if (setBy && setBy !== username) {
      const key = isReady ? "other-set-as-ready-notification" : "other-set-as-not-ready-notification";
      this.showMessage(formatMessage(getMessage(key), username, setBy));
      return;
    }
    if (username !== selfUsername) return;
    if (isReady) this.showMessage(getMessage("set-as-ready-notification"));
    else this.showMessage(getMessage("set-as-not-ready-notification"));
  }
}

export { OSD_WARNING_MESSAGE_DURATION_S };
