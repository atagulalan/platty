// The client core state machine. Ties together the protocol connection, the player, the
// playlist/userlist, and the sync algorithm. See ../../spec/client/overview-and-state-machine.md.
//
// Known simplifications vs. the reference client (see README "Known scope cuts"):
//   - Controller status is tracked from controllerAuth results, not derived from periodic List
//     polling.
//   - recentlyRewound() doesn't replicate the lastUpdatedFileTime nuance from client.py that
//     shortens the window right after a file switch.

import { EventEmitter } from "node:events";
import { ClientConnection, ConnectionAborted } from "./ClientConnection.js";
import { FileSwitchManager } from "./FileSwitchManager.js";
import { Playlist } from "./Playlist.js";
import { UserList } from "./UserList.js";
import { decideSyncAction, DEFAULT_SYNC_CONFIG, type SyncConfig } from "./syncAlgorithm.js";
import { applyPrivacy, sameFilename, type PrivacySettings } from "./privacy.js";
import { isURL, isURITrusted } from "./mediaUtils.js";
import { formatTime } from "./formatTime.js";
import { formatMessage, getMessage } from "./messages.js";
import { PlayerPresenter, type OsdSettings } from "./PlayerPresenter.js";
import type { Player, PlayerFileInfo, PlayerStatus } from "../players/BasePlayer.js";
import {
  AUTOPLAY_DELAY_S,
  DEFAULT_CLIENT_PORT,
  MUSIC_FORMATS,
  PROTOCOL_TIMEOUT_MS,
  PUBLIC_SYNCPLAY_HOST,
  RECENTLY_ADVANCED_WINDOW_S,
  RECONNECT_MAX_RETRIES,
  SEEK_THRESHOLD_S,
  nextPublicSyncplayPort,
  reconnectDelayMs,
} from "../protocol/constants.js";
import { isControlledRoomName } from "../protocol/roomPassword.js";
import type { FeatureFlags } from "../protocol/version.js";
import type { UnpauseAction } from "../config/types.js";

export interface SyncplayClientOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  room: string;
  privacy?: Partial<PrivacySettings>;
  syncConfig?: Partial<SyncConfig>;
  readyAtStart?: boolean;
  mediaSearchDirectories?: string[];
  sharedPlaylistEnabled?: boolean;
  onlySwitchToTrustedDomains?: boolean;
  trustedDomains?: string[];
  /** See spec/client/playlist-and-readiness.md#autoplay-and-instaplay. Default: "IfOthersReady",
   *  matching Python's default (see source/syncplay/ui/ConfigurationGetter.py). */
  unpauseAction?: UnpauseAction;
  /** Initial autoplay toggle state; mirrors config autoplayInitialState / GUI autoplayChecked. */
  autoplayInitialState?: boolean | null;
  autoplayMinUsers?: number;
  autoplayRequireSameFilenames?: boolean;
  /** Force-pause the player on an unplanned disconnect. See spec/client/reconnection-and-resilience.md. */
  pauseOnLeave?: boolean;
  loopAtEndOfPlaylist?: boolean;
  loopSingleFiles?: boolean;
  /** Player overlay / OSD behaviour — mirrors Syncplay's GUI (Syncplay) INI section. */
  osd?: Partial<OsdSettings>;
}

export interface ClientEvents {
  connected: [{ username: string; room: string; motd: string; requestedUsername?: string }];
  disconnected: [];
  reconnecting: [number];
  userlistUpdate: [];
  playlistUpdate: [];
  autoplayUpdate: [boolean];
  chat: [string, string];
  log: [string];
  error: [string];
  /** Slash command typed in mpv's syncplayintf chat overlay (without leading "/"). */
  playerInput: [string];
  /** Player closed unexpectedly (window quit / process exit), not an intentional client.stop(). */
  shutdown: [];
}

const DEFAULT_OSD: OsdSettings = {
  showOSD: true,
  showOSDWarnings: true,
  showSlowdownOSD: true,
  showSameRoomOSD: true,
  showDifferentRoomOSD: false,
  showNonControllerOSD: false,
  chatOutputEnabled: true,
};

const DEFAULT_PRIVACY: PrivacySettings = { filenameMode: "SendRaw", filesizeMode: "SendRaw" };

const DEFAULT_SERVER_FEATURES: FeatureFlags = {
  managedRooms: false,
  readiness: false,
  sharedPlaylists: false,
  chat: false,
  featureList: false,
  setOthersReadiness: false,
};

export class SyncplayClient extends EventEmitter {
  readonly userList = new UserList();
  readonly playlist = new Playlist();

  private readonly connection = new ClientConnection();
  private readonly fileSwitch = new FileSwitchManager();
  private readonly privacy: PrivacySettings;
  private readonly syncConfig: SyncConfig;
  private readonly osd: OsdSettings;
  private readonly presenter: PlayerPresenter;
  private readonly sharedPlaylistEnabled: boolean;
  private readonly trustedDomainOptions: {
    onlySwitchToTrustedDomains: boolean;
    trustedDomains: string[];
  };

  private username: string;
  private room: string;
  private ready: boolean | null = null;
  private isControlledRoom: boolean;
  private controllerSelf = true;

  private currentFile: PlayerFileInfo | null = null;
  private userOffset = 0;
  private hadFirstPlaylistIndex = false;

  // Local (player) clock.
  private playerPosition = 0;
  private playerPaused = true;
  private lastPlayerUpdate = Date.now();

  // Global (room-authoritative) clock.
  private globalPosition = 0;
  private globalPaused = true;
  private lastGlobalUpdate: number | null = null;
  private isFirstUpdate = true;

  private behindFirstDetected: number | null = null;
  private currentlySlowed = false;

  // Rewind anti-oscillation (client.py establishRewindDoubleCheck / recentlyRewound / setPosition
  // post-rewind guard - see spec/client/sync-algorithm.md and spec/client/reconnection-and-resilience.md).
  private lastRewindTime: number | null = null;
  private lastRewindPosition: number | null = null;
  private rewindDoubleCheckTimers: NodeJS.Timeout[] = [];

  private playerPositionBeforeLastSeek = 0;

  // Autoplay/instaplay (client.py instaplayConditionsMet / autoplayConditionsMet / startAutoplayCountdown).
  private autoPlay = false;
  private readonly unpauseAction: UnpauseAction;
  private autoplayThreshold: number | null;
  private readonly autoplayRequireSameFilenames: boolean;
  private serverFeatures: FeatureFlags = { ...DEFAULT_SERVER_FEATURES };
  private lastAdvanceTime: number | null = null;
  private autoplayTimer: NodeJS.Timeout | null = null;
  private autoplayTimeLeft = AUTOPLAY_DELAY_S;

  // Reconnection resilience.
  private readonly pauseOnLeave: boolean;
  private readonly loopAtEndOfPlaylist: boolean;
  private readonly loopSingleFiles: boolean;
  private pendingControllerAuth: { room: string; password: string } | null = null;
  private lastControllerAuth: { room: string; password: string } | null = null;

  private retries = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private manualDisconnect = false;
  private playlistMayNeedRestoring = false;
  private roomFileSwitchDone = false;
  private stateTicker: NodeJS.Timeout | null = null;
  private livenessChecker: NodeJS.Timeout | null = null;

  constructor(
    private readonly options: SyncplayClientOptions,
    private readonly player: Player,
  ) {
    super();
    this.username = options.username;
    this.room = options.room;
    this.isControlledRoom = isControlledRoomName(options.room);
    this.privacy = { ...DEFAULT_PRIVACY, ...options.privacy };
    this.syncConfig = { ...DEFAULT_SYNC_CONFIG, ...options.syncConfig };
    this.osd = { ...DEFAULT_OSD, ...options.osd };
    this.presenter = new PlayerPresenter(
      player,
      this.osd,
      (msg) => this.emit("log", msg),
      () => this.autoplayTimer !== null,
    );
    this.ready = options.readyAtStart ?? false;
    this.sharedPlaylistEnabled = options.sharedPlaylistEnabled ?? true;
    this.trustedDomainOptions = {
      onlySwitchToTrustedDomains: options.onlySwitchToTrustedDomains ?? true,
      trustedDomains: options.trustedDomains ?? [],
    };
    this.unpauseAction = options.unpauseAction ?? "IfOthersReady";
    this.autoPlay = options.autoplayInitialState ?? false;
    const minUsers = options.autoplayMinUsers ?? -1;
    this.autoplayThreshold = minUsers > 0 ? minUsers : null;
    this.autoplayRequireSameFilenames = options.autoplayRequireSameFilenames ?? true;
    this.pauseOnLeave = options.pauseOnLeave ?? false;
    this.loopAtEndOfPlaylist = options.loopAtEndOfPlaylist ?? false;
    this.loopSingleFiles = options.loopSingleFiles ?? false;
    this.fileSwitch.setMediaDirectories(options.mediaSearchDirectories ?? []);

    this.wirePlayer();
    this.wireConnection();
  }

  async start(): Promise<void> {
    await this.doConnect();
  }

  stop(): void {
    if (this.manualDisconnect) return; // idempotent - player.quit() re-emits 'close' -> stop()
    this.manualDisconnect = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.stateTicker) clearInterval(this.stateTicker);
    if (this.livenessChecker) clearInterval(this.livenessChecker);
    this.clearRewindDoubleCheckTimers();
    this.stopAutoplayCountdown();
    this.fileSwitch.stop();
    this.connection.destroy();
    this.player.quit();
  }

  /** Reconnect to the same server after a drop (does not change host/port). */
  manualReconnect(): void {
    this.retries = 0;
    this.connection.destroy();
    void this.doConnect();
  }

  // ---- connection lifecycle -----------------------------------------------------------------

  private async doConnect(): Promise<void> {
    this.connection.destroy();
    try {
      await this.connection.connect(this.options.host, this.options.port, {
        username: this.username,
        password: this.options.password,
        room: this.room,
      });
    } catch (err) {
      if (this.manualDisconnect || err instanceof ConnectionAborted) return;
      this.emitClientError(String(err));
      this.rotatePublicPortIfApplicable();
      this.scheduleReconnect();
    }
  }

  /** When syncplay.pl rejects a port (ECONNRESET), try the next public instance port. */
  private rotatePublicPortIfApplicable(): void {
    if (this.options.host.toLowerCase() !== PUBLIC_SYNCPLAY_HOST) return;
    if (this.options.port !== DEFAULT_CLIENT_PORT) {
      this.options.port = DEFAULT_CLIENT_PORT;
      this.emit("log", `Trying alternate port ${DEFAULT_CLIENT_PORT}...`);
      return;
    }
    const next = nextPublicSyncplayPort(this.options.port);
    if (next === null) return;
    this.options.port = next;
    this.emit("log", `Trying alternate port ${next}...`);
  }

  private emitClientError(message: string): void {
    if (this.manualDisconnect) return;
    if (this.listenerCount("error") > 0) this.emit("error", message);
    else this.emit("log", `Error: ${message}`);
    this.presenter.showOsdMessage(message, { osdType: "alert", mood: "bad" });
  }

  private scheduleReconnect(): void {
    if (this.manualDisconnect || this.retries > RECONNECT_MAX_RETRIES) return;
    if (this.pauseOnLeave) this.player.setPaused(true);
    const delay = reconnectDelayMs(this.retries);
    this.retries++;
    this.isFirstUpdate = true;
    this.lastGlobalUpdate = null;
    this.playlistMayNeedRestoring = true;
    this.emit("reconnecting", delay);
    this.presenter.notifyReconnecting();
    this.reconnectTimer = setTimeout(() => void this.doConnect(), delay);
  }

  // ---- wiring ---------------------------------------------------------------------------------

  private wirePlayer(): void {
    this.player.on("status", (status) => this.onPlayerStatus(status));
    this.player.on("fileInfo", (info) => this.onPlayerFileInfo(info));
    this.player.on("error", (err) => this.emitClientError(err.message));
    this.player.on("chatInput", (message) => {
      if (message.startsWith("/") && !message.startsWith("//")) {
        this.emit("playerInput", message.slice(1));
      } else if (message.startsWith("//")) {
        this.sendChat(message.slice(1));
      } else {
        this.sendChat(message);
      }
    });
    this.player.on("close", () => {
      if (this.manualDisconnect) return;
      this.stop();
      this.emit("shutdown");
    });
  }

  private wireConnection(): void {
    const c = this.connection;
    c.on("hello", ({ username, room, motd, features }) => {
      this.serverFeatures = features;
      const requestedUsername = this.username;
      this.username = username;
      this.room = room;
      this.retries = 0;
      this.hadFirstPlaylistIndex = false;
      this.roomFileSwitchDone = false;
      this.emit("connected", {
        username,
        room,
        motd,
        ...(username !== requestedUsername ? { requestedUsername } : {}),
      });
      this.presenter.notifyConnected();

      if (this.currentFile) this.sendFile(this.currentFile);
      c.sendReady(!!this.ready, false);
      c.requestList();

      // Mirrors Python's reIdentifyAsController(): if we were a controller before an unplanned
      // drop and still hold the room's control password, re-auth automatically after rejoining.
      if (this.controllerSelf && this.lastControllerAuth) {
        this.connection.requestControllerAuth(
          this.lastControllerAuth.room,
          this.lastControllerAuth.password,
        );
      }

      this.stateTicker = setInterval(() => this.sendCurrentState(false), 1000);
      this.livenessChecker = setInterval(() => this.checkLiveness(), 1000);
    });

    c.on("userEvent", (name, entry) => {
      const roomName = entry.room?.name ?? this.userList.get(name)?.room ?? this.room;
      const prev = this.userList.get(name);

      if (entry.event?.left) {
        if (name !== this.username && prev) {
          const hideFromPlayer = !this.osdHideForUser(name, prev.room, prev.controller);
          this.presenter.notifyUserLeft(name, hideFromPlayer);
        }
        this.userList.remove(name);
        this.emit("userlistUpdate");
        return;
      }

      const isJoin = !!entry.event?.joined || !prev;
      this.userList.upsert(name, {
        room: roomName,
        file: entry.file ?? prev?.file ?? null,
      });

      if (name !== this.username && (isJoin || entry.file)) {
        const user = this.userList.get(name);
        const hideFromPlayer = !this.osdHideForUser(name, roomName, user?.controller ?? false);
        this.presenter.notifyUserJoined(
          name,
          roomName,
          entry.file ?? null,
          formatTime,
          hideFromPlayer,
        );
      }

      this.emit("userlistUpdate");
      if (name !== this.username) {
        this.maybeSwitchToRoomMateFile("userEvent");
      }
    });

    c.on("list", (list) => {
      if (!list) return;
      for (const [roomName, users] of Object.entries(list)) {
        for (const [name, entry] of Object.entries(users)) {
          this.userList.upsert(name, {
            room: roomName,
            file: "name" in entry.file ? (entry.file as never) : null,
            ready: entry.isReady,
            controller: entry.controller,
          });
          if (name === this.username) this.controllerSelf = entry.controller;
        }
      }
      this.emit("userlistUpdate");
      this.maybeSwitchToRoomMateFile("list");
      this.checkAutoplay();
    });

    c.on("state", ({ position, paused, doSeek, setBy, messageAge }) => {
      if (position === undefined || paused === undefined) return;
      this.globalPosition = paused ? position : position + messageAge;
      this.globalPaused = paused;
      this.lastGlobalUpdate = Date.now();
      this.runSyncAlgorithm(doSeek, setBy);
    });

    c.on("chat", (username, message) => {
      this.emit("chat", username, message);
      this.presenter.showChatMessage(username, message);
    });

    c.on("controllerAuthStatus", (user, _room, success) => {
      if (user === this.username) {
        this.controllerSelf = success;
        if (success && this.pendingControllerAuth)
          this.lastControllerAuth = this.pendingControllerAuth;
      }
      this.presenter.notifyControllerAuth(user, this.username, success);
    });

    c.on("readyUpdate", (username, isReady, _manuallyInitiated, setBy) => {
      this.userList.upsert(username, { ready: isReady });
      if (username === this.username) this.ready = isReady;
      // Python client.py setReady() only surfaces readiness to the UI when setBy is present.
      if (setBy) {
        this.presenter.notifyReadyChange(username, isReady, setBy, this.username);
      }
      this.emit("userlistUpdate");
      this.checkAutoplay();
    });

    c.on("playlistChange", (user, files) => {
      const restoring = this.playlist.needsRestoring(
        files,
        user !== undefined,
        this.playlistMayNeedRestoring,
      );
      this.playlistMayNeedRestoring = false;
      if (restoring) {
        c.sendPlaylist(this.playlist.files);
        return;
      }
      this.playlist.setFromRemote(files);
      this.emit("playlistUpdate");

      const fromRemoteUser = user !== undefined && user !== this.username;
      const fromRoomState = user === undefined;
      if (
        this.sharedPlaylistEnabled &&
        (fromRemoteUser || fromRoomState) &&
        this.playlist.index !== null
      ) {
        void this.switchToNewPlaylistIndex(this.playlist.index, this.hadFirstPlaylistIndex);
      }
    });

    c.on("playlistIndex", (user, index) => {
      const resetPosition = this.hadFirstPlaylistIndex;
      this.hadFirstPlaylistIndex = true;
      if (index != null && typeof index === "number" && !Number.isNaN(index)) {
        if (index !== this.playlist.index) this.lastAdvanceTime = Date.now();
        this.playlist.setIndexFromRemote(index);
      }
      this.emit("playlistUpdate");
      this.checkAutoplay();

      const fromRemoteUser = user !== undefined && user !== this.username;
      const fromRoomState = user === undefined;
      if (
        this.sharedPlaylistEnabled &&
        (fromRemoteUser || fromRoomState) &&
        index != null &&
        typeof index === "number" &&
        !Number.isNaN(index)
      ) {
        void this.switchToNewPlaylistIndex(index, resetPosition);
      }
    });

    c.on("error", (message) => this.emitClientError(message));

    c.on("close", () => {
      if (this.manualDisconnect) return;
      if (this.stateTicker) clearInterval(this.stateTicker);
      if (this.livenessChecker) clearInterval(this.livenessChecker);
      this.connection.destroy();
      this.emit("disconnected");
      this.scheduleReconnect();
    });
  }

  // ---- player-facing clock --------------------------------------------------------------------

  private getPlayerPosition(): number {
    if (this.playerPaused) return this.playerPosition;
    return this.playerPosition + (Date.now() - this.lastPlayerUpdate) / 1000;
  }

  private getGlobalPosition(): number {
    if (this.globalPaused || this.lastGlobalUpdate === null) return this.globalPosition;
    return this.globalPosition + (Date.now() - this.lastGlobalUpdate) / 1000;
  }

  private onPlayerStatus(status: PlayerStatus): void {
    const previousExpected = this.getPlayerPosition();
    const pauseChanged = status.paused !== this.playerPaused;
    const jump = Math.abs(status.position - previousExpected) > SEEK_THRESHOLD_S;

    // Post-rewind seek-suppression window (client.py ~825-830): a large forward jump reported
    // just after we forced a rewind-to-a-lower-position is almost always a stale/racing player
    // report, not a real seek - drop it instead of re-forwarding it as a state change.
    if (
      jump &&
      !pauseChanged &&
      this.lastRewindTime !== null &&
      this.lastRewindPosition !== null &&
      Date.now() - this.lastRewindTime < 1000 &&
      status.position > this.lastRewindPosition + 5
    ) {
      return;
    }

    this.playerPosition = status.position;
    this.playerPaused = status.paused;
    this.lastPlayerUpdate = Date.now();

    if (!pauseChanged && !jump) return;

    const sendPauseChange = pauseChanged ? this.handlePauseToggle(status.paused) : false;

    if (sendPauseChange || jump) this.sendCurrentState(true, jump);
  }

  /**
   * Mirrors Python's _toggleReady(): decides whether/how a local pause/unpause edge propagates to
   * readiness and the outgoing state message. Returns whether to still forward this edge as a
   * pause-change state update (false means the player was reverted and nothing should be sent).
   */
  private handlePauseToggle(paused: boolean): boolean {
    const canControl = !this.isControlledRoom || this.controllerSelf;

    if (!canControl) {
      // Non-controller in a managed room: pausing never actually pauses anyone - revert the
      // player and toggle readiness instead. See spec/client/sync-algorithm.md#readiness-coupling.
      this.player.setPaused(this.globalPaused);
      if (!this.recentlyRewound() && !(this.globalPaused && !this.recentlyAdvanced())) {
        this.setReady(!paused, true);
      }
      this.playerPaused = this.globalPaused;
      return false;
    }

    if (this.isPlayingMusic() && this.recentlyAdvanced()) {
      // Seamless music override: let the pause edge through untouched, don't touch readiness -
      // avoids forcing a readiness prompt between back-to-back auto-advanced tracks.
      return true;
    }

    if (this.recentlyRewound() && this.globalPaused && !this.recentlyAdvanced()) {
      this.player.setPaused(this.globalPaused);
      this.playerPaused = this.globalPaused;
      return false;
    }

    if (!paused && !this.instaplayConditionsMet()) {
      this.player.setPaused(true);
      this.playerPaused = true;
      if (this.ready) {
        this.presenter.showMessage(getMessage("ready-to-unpause-notification"));
      } else {
        this.setReady(true, true);
      }
      return false;
    }

    // Mirrors client.py changeReadyState(..., manuallyInitiated=False) — no UI notification.
    this.setReady(!paused, false);
    return true;
  }

  /** See spec/client/playlist-and-readiness.md#autoplay-and-instaplay; client.py instaplayConditionsMet(). */
  private instaplayConditionsMet(): boolean {
    if (this.isPlayingMusic()) return true;
    const canControl = !this.isControlledRoom || this.controllerSelf;
    if (!canControl) return false;

    if (this.ready === true || this.unpauseAction === "Always") return true;

    const othersReady = this.userList.areAllOtherUsersInRoomReady(this.room, this.username);
    if (this.unpauseAction === "IfOthersReady" && othersReady) return true;
    if (
      this.unpauseAction === "IfMinUsersReady" &&
      othersReady &&
      this.autoplayThreshold !== null &&
      this.userList.usersInRoomCount(this.room, this.username) >= this.autoplayThreshold
    ) {
      return true;
    }
    return false;
  }

  /** client.py isPlayingMusic(). */
  private isPlayingMusic(): boolean {
    const name = this.currentFile?.name;
    if (!name) return false;
    const lower = name.toLowerCase();
    return MUSIC_FORMATS.some((ext) => lower.endsWith(ext));
  }

  /** client.py seamlessMusicOveride(). */
  private seamlessMusicOverride(): boolean {
    return this.isPlayingMusic() && this.recentlyAdvanced();
  }

  /** client.py userlist.isReadinessSupported(). */
  private isReadinessSupported(): boolean {
    if (!this.serverFeatures.readiness) return false;
    if (this.userList.onlyUserInRoomWhoSupportsReadiness(this.room, this.username)) return false;
    return true;
  }

  /** client.py _recentlyAdvanced(). */
  private recentlyAdvanced(): boolean {
    if (this.lastAdvanceTime === null) return false;
    return (Date.now() - this.lastAdvanceTime) / 1000 < RECENTLY_ADVANCED_WINDOW_S;
  }

  /** client.py recentlyRewound() (simplified: no lastUpdatedFileTime adjustment). */
  private recentlyRewound(thresholdS = 5.0): boolean {
    return this.lastRewindTime !== null && (Date.now() - this.lastRewindTime) / 1000 < thresholdS;
  }

  /** client.py autoplayConditionsMet() / startAutoplayCountdown() / autoplayCountdown(). */
  private autoplayConditionsMet(): boolean {
    if (this.seamlessMusicOverride()) {
      this.player.setPaused(false);
    }
    const recentlyAdvanced = this.recentlyAdvanced();
    if (!this.playerPaused) return false;
    if (!(this.autoPlay || recentlyAdvanced)) return false;
    const canControl = !this.isControlledRoom || this.controllerSelf;
    if (!canControl) return false;
    if (!this.isReadinessSupported()) return false;
    if (
      !this.userList.areAllUsersInRoomReady(
        this.room,
        this.username,
        this.autoplayRequireSameFilenames,
      )
    ) {
      return false;
    }
    const meetsThreshold =
      this.autoplayThreshold !== null &&
      this.userList.usersInRoomCount(this.room, this.username) >= this.autoplayThreshold;
    return meetsThreshold || recentlyAdvanced;
  }

  /** client.py autoplayCheck(). */
  private checkAutoplay(): void {
    if (this.isPlayingMusic()) {
      if (this.seamlessMusicOverride()) {
        this.player.setPaused(false);
      }
      return;
    }
    if (this.autoplayConditionsMet()) this.startAutoplayCountdown();
    else this.stopAutoplayCountdown();
  }

  private startAutoplayCountdown(): void {
    if (this.autoplayTimer) return;
    this.autoplayTimeLeft = AUTOPLAY_DELAY_S;
    this.autoplayTimer = setInterval(() => {
      if (!this.autoplayConditionsMet()) {
        this.stopAutoplayCountdown();
        return;
      }
      this.presenter.notifyAutoplayCountdown(
        this.autoplayTimeLeft,
        this.userList.readyUserCount(this.room, this.username),
      );
      if (this.autoplayTimeLeft <= 0) {
        this.player.setPaused(false);
        this.stopAutoplayCountdown();
      } else {
        this.autoplayTimeLeft -= 1;
      }
    }, 1000);
  }

  private stopAutoplayCountdown(): void {
    if (this.autoplayTimer) {
      clearInterval(this.autoplayTimer);
      this.autoplayTimer = null;
    }
    this.autoplayTimeLeft = AUTOPLAY_DELAY_S;
  }

  /** client.py establishRewindDoubleCheck() / doubleCheckRewindFile(). */
  private scheduleRewindDoubleCheck(): void {
    this.clearRewindDoubleCheckTimers();
    for (const delayMs of [500, 1000, 1500]) {
      this.rewindDoubleCheckTimers.push(
        setTimeout(() => {
          if (
            this.lastRewindPosition !== null &&
            this.getPlayerPosition() > this.lastRewindPosition + 5
          ) {
            this.player.setPosition(this.lastRewindPosition + this.userOffset);
          }
        }, delayMs),
      );
    }
  }

  private clearRewindDoubleCheckTimers(): void {
    for (const timer of this.rewindDoubleCheckTimers) clearTimeout(timer);
    this.rewindDoubleCheckTimers = [];
  }

  private onPlayerFileInfo(info: PlayerFileInfo): void {
    this.currentFile = info;
    this.isFirstUpdate = true;
    if (this.connection.isConnected) this.sendFile(info);
  }

  private sendFile(info: PlayerFileInfo): void {
    const { name, size } = applyPrivacy(info.name, 0, this.privacy);
    this.connection.sendFile({ name, size, duration: info.duration });
  }

  private sendCurrentState(stateChange: boolean, doSeek = false): void {
    if (!this.connection.isConnected) return;
    // client.py getLocalState(): with dontSlowDownWithMe, report the room-authoritative position
    // instead of our own so this client's real position never causes others to slow down for it.
    const localPosition = this.syncConfig.dontSlowDownWithMe
      ? this.getGlobalPosition()
      : this.getPlayerPosition();
    const reported = localPosition - this.userOffset;
    this.connection.sendState(reported, this.playerPaused, doSeek, stateChange);
  }

  private checkLiveness(): void {
    if (
      this.lastGlobalUpdate !== null &&
      Date.now() - this.lastGlobalUpdate > PROTOCOL_TIMEOUT_MS
    ) {
      this.emitClientError("server-timeout");
      this.connection.destroy();
    }
  }

  // ---- sync algorithm wiring --------------------------------------------------------------------

  private runSyncAlgorithm(doSeek: boolean, setBy: string | null): void {
    const canControl = !this.isControlledRoom || this.controllerSelf;
    const prevPaused = this.playerPaused;
    const prevSlowed = this.currentlySlowed;
    const positionBefore = this.getPlayerPosition();
    const wasFirstUpdate = this.isFirstUpdate;

    const decision = decideSyncAction({
      playerPosition: this.getPlayerPosition(),
      playerPaused: this.playerPaused,
      globalPosition: this.getGlobalPosition(),
      globalPaused: this.globalPaused,
      doSeek,
      setBy,
      selfUsername: this.username,
      isFirstUpdate: this.isFirstUpdate,
      canControl,
      speedSupported: this.player.speedSupported,
      config: this.syncConfig,
      behindFirstDetected: this.behindFirstDetected,
      currentlySlowed: this.currentlySlowed,
      now: Date.now() / 1000,
    });
    this.isFirstUpdate = false;
    this.behindFirstDetected = decision.behindFirstDetected;

    if (setBy && setBy !== this.username && !wasFirstUpdate) {
      if (doSeek && decision.seekTo !== undefined) {
        this.presenter.notifySeek(
          setBy,
          positionBefore - this.userOffset,
          decision.seekTo,
          formatTime,
        );
      } else if (decision.isRewind) {
        this.presenter.notifyRewind(setBy);
      } else if (decision.isFastForward) {
        this.presenter.notifyFastForward(setBy);
      }
      if (decision.setPaused !== undefined && decision.setPaused !== prevPaused) {
        if (decision.setPaused) {
          this.presenter.notifyPaused(setBy, this.getGlobalPosition(), formatTime);
        } else {
          this.presenter.notifyUnpaused(setBy);
        }
      }
      if (decision.setSpeed !== undefined) {
        if (decision.setSpeed !== 1.0 && !prevSlowed) {
          this.presenter.notifySlowdown(setBy);
        } else if (decision.setSpeed === 1.0 && prevSlowed) {
          this.presenter.notifyRevert();
        }
      }
    }

    if (doSeek && setBy && setBy !== this.username) {
      this.playerPositionBeforeLastSeek = positionBefore;
    }

    if (decision.seekTo !== undefined) {
      this.player.setPosition(decision.seekTo + this.userOffset);
      if (decision.isRewind) {
        this.lastRewindTime = Date.now();
        this.lastRewindPosition = decision.seekTo;
        this.scheduleRewindDoubleCheck();
      }
    }
    if (decision.setPaused !== undefined) this.player.setPaused(decision.setPaused);
    if (decision.setSpeed !== undefined) {
      this.player.setSpeed(decision.setSpeed);
      this.currentlySlowed = decision.setSpeed !== 1.0;
    }
  }

  /** Whether OSD notifications for a user in `userRoom` should reach the player overlay. */
  private osdHideForUser(_username: string, userRoom: string, isController: boolean): boolean {
    return !this.presenter.shouldShowForRoom(userRoom, this.room, isController);
  }

  // ---- public actions used by the TUI --------------------------------------------------------

  setReady(isReady: boolean, manuallyInitiated = true): void {
    // Mirrors client.py changeReadyState() — skip no-op updates.
    if (this.ready === isReady) return;
    this.ready = isReady;
    this.connection.sendReady(isReady, manuallyInitiated);
    this.userList.upsert(this.username, { ready: isReady });
    if (manuallyInitiated) {
      this.presenter.notifyReadyChange(this.username, isReady, undefined, this.username);
    }
    this.emit("userlistUpdate");
  }

  toggleReady(): void {
    this.setReady(!this.ready);
  }

  /** Mirrors client.py changeAutoplayState(). */
  changeAutoplayState(newState: boolean): void {
    this.autoPlay = newState;
    this.emit("autoplayUpdate", newState);
    this.checkAutoplay();
  }

  /** Mirrors client.py changeAutoPlayThrehsold(). */
  changeAutoplayThreshold(newThreshold: number): void {
    const oldMet = this.autoplayConditionsMet();
    this.autoplayThreshold = newThreshold > 0 ? newThreshold : null;
    const newMet = this.autoplayConditionsMet();
    if (!oldMet && newMet) this.checkAutoplay();
    else this.checkAutoplay();
  }

  /** Mirrors client.py resetAutoPlayState(). */
  private resetAutoPlayState(): void {
    this.autoPlay = false;
    this.emit("autoplayUpdate", false);
    this.stopAutoplayCountdown();
  }

  get autoPlayEnabled(): boolean {
    return this.autoPlay;
  }

  setUserOffset(seconds: number): void {
    this.userOffset = seconds;
    this.player.setPosition(this.getGlobalPosition() + this.userOffset);
    this.presenter.showMessage(formatMessage(getMessage("current-offset-notification"), seconds));
  }

  /** Current user (A/V) offset in seconds, for UIs that need to compute a relative adjustment. */
  get userOffsetSeconds(): number {
    return this.userOffset;
  }

  /** Currently-loaded local file's name, if any — used for /room's "current file" default-name fallback. */
  get currentFileName(): string | null {
    return this.currentFile?.name ?? null;
  }

  /**
   * Ask the server to mark another user's readiness (requires the server's `setOthersReadiness`
   * feature, advertised in our Hello features - see ClientConnection.sendHello). Mirrors
   * source/syncplay/client.py:983 `setOthersReadiness`.
   */
  setOthersReadiness(username: string, isReady: boolean): void {
    this.connection.sendReady(isReady, true, username);
  }

  togglePlayPause(): void {
    this.player.setPaused(!this.playerPaused);
  }

  seekTo(seconds: number): void {
    this.player.setPosition(seconds);
  }

  seekRelative(deltaSeconds: number): void {
    this.player.setPosition(this.getPlayerPosition() + deltaSeconds);
  }

  sendChat(message: string): void {
    this.connection.sendChat(message);
  }

  changeRoom(name: string, password?: string): void {
    this.room = name;
    this.isControlledRoom = isControlledRoomName(name);
    this.controllerSelf = true;
    this.isFirstUpdate = true;
    this.hadFirstPlaylistIndex = false;
    this.roomFileSwitchDone = false;
    this.resetAutoPlayState();
    this.userList.clear();
    this.connection.sendRoom(name, password);
    this.connection.requestList();
  }

  requestControl(roomBaseName: string, password: string): void {
    this.pendingControllerAuth = { room: roomBaseName, password };
    this.connection.requestControllerAuth(roomBaseName, password);
  }

  addToPlaylist(file: string): void {
    const files = this.playlist.add(file);
    this.playlist.setLocal(files);
    this.connection.sendPlaylist(files);
    this.emit("playlistUpdate");
  }

  removeFromPlaylist(index: number): void {
    const files = this.playlist.deleteAt(index);
    this.playlist.setLocal(files);
    this.connection.sendPlaylist(files);
    this.emit("playlistUpdate");
  }

  selectPlaylistIndex(index: number): void {
    if (index < 0 || index >= this.playlist.files.length) return;
    if (index !== this.playlist.index) this.lastAdvanceTime = Date.now();
    this.playlist.index = index;
    this.connection.sendPlaylistIndex(index);
    void this.switchToNewPlaylistIndex(index, true);
    this.checkAutoplay();
  }

  /** Mirrors source/syncplay/client.py SyncplayPlaylist.loadNextFileInPlaylist(). */
  loadNextFileInPlaylist(): void {
    const { index, files } = this.playlist;
    if (index === null || files.length === 0) return;

    if (files.length === 1 && this.loopSingleFilesEnabled()) {
      this.lastAdvanceTime = Date.now();
      this.seekTo(0);
      this.player.setPaused(false);
      return;
    }

    const nextIndex = this.nextPlaylistIndex();
    if (nextIndex === null) return;

    this.selectPlaylistIndex(nextIndex);
  }

  private loopSingleFilesEnabled(): boolean {
    return this.loopSingleFiles || this.isPlayingMusic();
  }

  private isPlaylistLoopingEnabled(): boolean {
    return this.loopAtEndOfPlaylist || this.isPlayingMusic();
  }

  private nextPlaylistIndex(): number | null {
    const { index, files } = this.playlist;
    if (index === null) return null;
    if (files.length === 1 && !this.loopSingleFilesEnabled()) return null;
    if (index + 1 >= files.length) {
      return this.isPlaylistLoopingEnabled() ? 0 : null;
    }
    return index + 1;
  }

  undoPlaylist(): void {
    const restored = this.playlist.undo();
    if (!restored) return;
    this.playlist.setLocal(restored.files);
    this.connection.sendPlaylist(restored.files);
    this.emit("playlistUpdate");
  }

  get selfUsername(): string {
    return this.username;
  }

  get currentRoom(): string {
    return this.room;
  }

  get isReady(): boolean | null {
    return this.ready;
  }

  /** Resolve a playlist entry and open it locally. See spec/client/playlist-and-readiness.md. */
  private async switchToNewPlaylistIndex(index: number, resetPosition: boolean): Promise<void> {
    if (!this.sharedPlaylistEnabled) return;

    const filename = this.playlist.files[index];
    if (!filename) return;

    const opened = await this.openMatchingFile(filename, resetPosition);
    if (opened) this.roomFileSwitchDone = true;
  }

  /**
   * When the shared playlist is empty, try opening a file that another user in the same room is
   * playing if it exists locally. Complements playlist-index switching for rooms where users open
   * files directly without populating the shared playlist.
   */
  private maybeSwitchToRoomMateFile(source: string): void {
    if (this.roomFileSwitchDone) return;

    const mates = this.userList
      .inRoom(this.room)
      .filter((u) => u.username !== this.username && u.file?.name);

    if (mates.length === 0) return;

    void (async () => {
      for (const mate of mates) {
        const filename = mate.file!.name;
        if (this.currentFile && sameFilename(filename, this.currentFile.name)) {
          this.roomFileSwitchDone = true;
          return;
        }
        const opened = await this.openMatchingFile(filename, false);
        if (opened) {
          this.roomFileSwitchDone = true;
          return;
        }
      }
    })();
  }

  private async openMatchingFile(filename: string, resetPosition: boolean): Promise<boolean> {
    if (this.currentFile && sameFilename(filename, this.currentFile.name)) {
      return false;
    }

    if (isURL(filename)) {
      if (isURITrusted(filename, this.trustedDomainOptions)) {
        await this.player.open(filename);
        return true;
      }
      this.emit("log", `Cannot auto-open untrusted URL: ${filename}`);
      return false;
    }

    const path = this.fileSwitch.findFilepath(filename, this.currentFile);
    if (path) {
      await this.player.open(path);
      if (resetPosition) {
        this.player.setPosition(0);
        this.player.setPaused(true);
      }
      return true;
    }

    return false;
  }
}
