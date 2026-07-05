// The server-wide singleton (factory equivalent). See ../../../spec/server/overview-and-cli.md.
//
// Implements: room isolation, managed/controlled rooms, playlist validation, MOTD templating
// (including the old-client warning and userIp substitution), chat/username/filename/room-name
// truncation, the 1.2.255 handshake compatibility hack, the full ignoringOnTheFly flow control,
// room/playlist persistence (--rooms-db-file), permanent rooms (--permanent-rooms-file), basic
// version-adoption stats (--stats-db-file), in-band STARTTLS (--tls), and dual-stack/env-var CLI
// options. See the doc comments on the individual options below for known simplifications vs.
// the reference implementation (mostly: no byte-identical DB format, no TLS cert hot-reload).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { generateServerSalt } from "../protocol/roomPassword.js";
import {
  MAX_CHAT_MESSAGE_LENGTH,
  MAX_USERNAME_LENGTH,
  REAL_VERSION,
  SERVER_STATS_SNAPSHOT_INTERVAL_MS,
} from "../protocol/constants.js";
import type { FeatureFlags } from "../protocol/version.js";
import { loadMotdFile, renderMotdFor as renderMotdTemplate } from "./motd.js";
import { RoomManager } from "./RoomManager.js";
import { Room, ControlledRoom } from "./Room.js";
import type { Watcher } from "./Watcher.js";
import { ServerConnection } from "./ServerConnection.js";
import type { ListMessage, ListUserEntry } from "../protocol/types.js";
import { openRoomsStore, openStatsStore, loadPermanentRoomNames, type StatsStore } from "./persistence.js";

export interface TlsCredentials {
  cert: Buffer;
  key: Buffer;
}

export interface SyncServerOptions {
  port?: number;
  host?: string;
  password?: string;
  salt?: string;
  motdFile?: string;
  isolateRooms?: boolean;
  disableReady?: boolean;
  disableChat?: boolean;
  maxChatMessageLength?: number;
  maxUsernameLength?: number;
  log?: (line: string) => void;

  /** --rooms-db-file: persist room playlists/index across restarts. See persistence.ts. */
  roomsDbFile?: string;
  /** --permanent-rooms-file: newline-delimited room names that survive being emptied. */
  permanentRoomsFile?: string;
  /** --stats-db-file: hourly connection-count/version-histogram snapshots. */
  statsDbFile?: string;

  /**
   * --tls <cert-dir>: directory containing `cert.pem` and `key.pem`. Simplified vs. the
   * reference server (which reads `privkey.pem`/`cert.pem`/`chain.pem`, pins TLS 1.2+, and
   * restricts the cipher list) - no intermediate chain support, no cipher pinning, no lazy
   * cert-mtime hot-reload. See ServerConnection.ts's handleTLS for the in-band upgrade itself,
   * and its doc comment for a caveat about the socket-swap mechanism.
   */
  tlsCertDir?: string;

  /** --ipv4-only / --ipv6-only: restrict the default listener to one address family. */
  ipv4Only?: boolean;
  ipv6Only?: boolean;
  /** --interface-ipv4 / --interface-ipv6: bind explicit addresses (implies dual-stack if both given). */
  interfaceIpv4?: string;
  interfaceIpv6?: string;
}

export class SyncServer {
  readonly roomManager: RoomManager;
  readonly password: string | null;
  readonly salt: string;
  readonly disableReady: boolean;
  readonly disableChat: boolean;
  readonly maxChatMessageLength: number;
  readonly maxUsernameLength: number;
  readonly roomsDbFile: string | null;
  /** null = TLS not configured/available; ServerConnection replies TLS.startTLS=false. */
  readonly tlsCredentials: TlsCredentials | null;

  private readonly motdTemplate: string | null;
  private readonly log: (line: string) => void;
  private readonly servers: Server[];
  private readonly listenHosts: string[];
  private readonly statsStore: StatsStore | null;
  private statsTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: SyncServerOptions = {}) {
    const isolateRooms = !!options.isolateRooms;

    // Per spec/server/rooms-and-permissions.md#room-isolation: the reference server drops
    // --rooms-db-file/--permanent-rooms-file support entirely under --isolate-rooms (it
    // constructs a bare PublicRoomManager with no arguments in that case) - replicate that by
    // simply not opening/passing the stores when isolated.
    const roomsStore = !isolateRooms && options.roomsDbFile ? openRoomsStore(options.roomsDbFile) : undefined;
    const permanentRoomNames =
      !isolateRooms && options.permanentRoomsFile ? loadPermanentRoomNames(options.permanentRoomsFile) : undefined;
    this.roomsDbFile = !isolateRooms ? (options.roomsDbFile ?? null) : null;

    this.roomManager = new RoomManager({ isolateRooms, roomsStore, permanentRoomNames });
    this.password = options.password ? createHash("md5").update(options.password, "utf8").digest("hex") : null;
    this.log = options.log ?? ((line: string) => console.log(line));

    if (options.salt) {
      this.salt = options.salt;
    } else {
      this.salt = generateServerSalt();
      this.log(`No --salt given; generated random salt for this run: ${this.salt}`);
      this.log("Managed-room links created now will stop working if the server restarts without this salt.");
    }

    this.disableReady = !!options.disableReady;
    this.disableChat = !!options.disableChat;
    this.maxChatMessageLength = options.maxChatMessageLength ?? MAX_CHAT_MESSAGE_LENGTH;
    this.maxUsernameLength = options.maxUsernameLength ?? MAX_USERNAME_LENGTH;
    this.motdTemplate = options.motdFile ? loadMotdFile(options.motdFile) : null;

    this.tlsCredentials = this.loadTlsCredentials(options.tlsCertDir);

    this.statsStore = options.statsDbFile ? openStatsStore(options.statsDbFile) : null;
    if (this.statsStore) {
      this.statsTimer = setInterval(() => this.recordStatsSnapshot(), SERVER_STATS_SNAPSHOT_INTERVAL_MS);
      this.statsTimer.unref?.();
    }

    this.listenHosts = this.resolveListenHosts();
    this.servers = this.listenHosts.map(() => createServer((socket: Socket) => this.onConnection(socket)));
  }

  private loadTlsCredentials(certDir: string | undefined): TlsCredentials | null {
    if (!certDir) return null;
    try {
      const cert = readFileSync(`${certDir}/cert.pem`);
      const key = readFileSync(`${certDir}/key.pem`);
      this.log("TLS support is enabled.");
      return { cert, key };
    } catch (e) {
      this.log("Error while loading the TLS certificates.");
      this.log(String(e));
      this.log("TLS support is not enabled.");
      return null;
    }
  }

  /** See spec/server/overview-and-cli.md#reactor-wiring - dual-stack by default. */
  private resolveListenHosts(): string[] {
    const o = this.options;
    if (o.interfaceIpv4 && o.interfaceIpv6) return [o.interfaceIpv4, o.interfaceIpv6];
    if (o.interfaceIpv4) return [o.interfaceIpv4];
    if (o.interfaceIpv6) return [o.interfaceIpv6];
    if (o.ipv4Only) return ["0.0.0.0"];
    if (o.ipv6Only) return ["::"];
    // Unchanged default behavior (single listener) when none of the new flags are given.
    return [o.host ?? "0.0.0.0"];
  }

  listen(): Promise<void> {
    const port = this.options.port ?? 8999;
    return Promise.all(
      this.servers.map(
        (server, i) =>
          new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(port, this.listenHosts[i], () => {
              server.removeListener("error", reject);
              resolve();
            });
          }),
      ),
    ).then(() => undefined);
  }

  close(): Promise<void> {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsStore?.close();
    this.roomManager.close();
    return Promise.all(this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))).then(
      () => undefined,
    );
  }

  private recordStatsSnapshot(): void {
    const versions = this.roomManager.allWatchers().map((w) => w.connection.peerVersion);
    this.statsStore?.recordSnapshot(versions);
  }

  private onConnection(socket: Socket): void {
    new ServerConnection(this, socket);
  }

  getFeatures(): Record<string, unknown> {
    return {
      isolateRooms: this.roomManager.isolateRooms,
      readiness: !this.disableReady,
      managedRooms: true,
      persistentRooms: this.roomsDbFile !== null,
      chat: !this.disableChat,
      maxChatMessageLength: this.maxChatMessageLength,
      maxUsernameLength: this.maxUsernameLength,
      maxRoomNameLength: 35,
      maxFilenameLength: 250,
      setOthersReadiness: true,
    };
  }

  /**
   * `version` uses the protocol realversion (REAL_VERSION) rather than this rewrite's own
   * package.json semver - historically `$version` in a Syncplay MOTD template resolves to the
   * app/protocol version users recognize (e.g. "1.7.6"), which REAL_VERSION mirrors; the
   * package.json version ("0.1.0") describes this TS rewrite's own release cadence and would be
   * a confusing/meaningless value to show end users in a templated welcome message.
   */
  renderMotdFor(username: string, room: string, userIp: string, clientVersion: string): string {
    return renderMotdTemplate(this.motdTemplate, { version: REAL_VERSION, userIp, username, room }, clientVersion);
  }

  removeWatcher(watcher: Watcher): void {
    const room = watcher.room;
    room.removeWatcher(watcher.name);
    this.broadcastUserEvent(watcher, { left: true }, room);
    this.roomManager.deleteRoomIfEmpty(room);
  }

  moveWatcherToRoom(watcher: Watcher, newRoomName: string): void {
    const oldRoom = watcher.room;
    if (oldRoom.name === newRoomName) return;

    oldRoom.removeWatcher(watcher.name);
    this.broadcastUserEvent(watcher, { left: true }, oldRoom);
    this.roomManager.deleteRoomIfEmpty(oldRoom);

    const newRoom = this.roomManager.getOrCreateRoom(newRoomName);
    watcher.room = newRoom;
    newRoom.addWatcher(watcher);
    this.broadcastUserEvent(watcher, { joined: true });
  }

  broadcastUserEvent(
    watcher: Watcher,
    event: { joined?: boolean; left?: boolean; version?: string } | undefined,
    roomOverride?: Room,
  ): void {
    const room = roomOverride ?? watcher.room;
    const targets = this.roomManager.visibleWatchers(room);
    for (const target of targets) {
      target.connection.sendEnvelope({
        Set: {
          user: {
            [watcher.name]: {
              room: { name: room.name },
              ...(watcher.file ? { file: watcher.file } : {}),
              ...(event ? { event } : {}),
            },
          },
        },
      });
    }
  }

  broadcastChat(from: Watcher, message: string): void {
    const targets = this.roomManager.visibleWatchers(from.room);
    for (const target of targets) {
      if (!target.connection.meetsFeature("chat")) continue;
      target.connection.receiveChat(from.name, message);
    }
  }

  /** Success/failure is broadcast server-wide unless room isolation is on. */
  broadcastControllerAuthStatus(user: string, room: string, success: boolean): void {
    const targets = success
      ? this.roomManager.isolateRooms
        ? this.roomManager.allWatchers().filter((w) => w.room.name === room)
        : this.roomManager.allWatchers()
      : this.roomManager.allWatchers().filter((w) => w.room.name === room);
    for (const target of targets) {
      target.connection.sendEnvelope({ Set: { controllerAuth: { user, room, success } } });
    }
  }

  /**
   * Re-send controller-auth-status for every existing controller of `watcher`'s current room to
   * `watcher` only - called on join/room-switch so the joiner's UI immediately reflects who's an
   * operator, without re-broadcasting to everyone else. See
   * spec/server/rooms-and-permissions.md#room-lifecycle ("also re-sends
   * sendControlledRoomAuthStatus for existing controllers").
   */
  sendControllerAuthStatusToWatcher(watcher: Watcher): void {
    const room = watcher.room;
    if (!(room instanceof ControlledRoom)) return;
    for (const controllerName of room.controllers) {
      watcher.connection.sendEnvelope({ Set: { controllerAuth: { user: controllerName, room: room.name, success: true } } });
    }
  }

  broadcastReady(target: Watcher, manuallyInitiated: boolean, setBy?: string): void {
    for (const w of this.roomManager.visibleWatchers(target.room)) {
      w.connection.sendEnvelope({
        Set: {
          ready: {
            username: target.name,
            isReady: !!target.ready,
            manuallyInitiated,
            ...(setBy ? { setBy } : {}),
          },
        },
      });
      if (setBy && !w.connection.meetsFeature("setOthersReadiness")) {
        w.connection.receiveChat(
          target.name,
          target.ready ? `${target.name} is now ready` : `${target.name} is no longer ready`,
        );
      }
    }
  }

  broadcastPlaylistChange(room: Room, user: string): void {
    for (const w of room.watchers.values()) {
      w.connection.sendEnvelope({ Set: { playlistChange: { user, files: room.playlist } } });
    }
    this.roomManager.persistRoom(room);
  }

  broadcastPlaylistIndex(room: Room, user: string): void {
    for (const w of room.watchers.values()) {
      w.connection.sendEnvelope({ Set: { playlistIndex: { user, index: room.playlistIndex ?? 0 } } });
    }
    this.roomManager.persistRoom(room);
  }

  buildListFor(room: Room): ListMessage {
    const result: ListMessage = {};
    for (const visibleRoom of this.roomManager.visibleRooms(room)) {
      const entries: Record<string, ListUserEntry> = {};
      for (const w of visibleRoom.watchers.values()) {
        entries[w.name] = {
          position: 0,
          file: w.file ?? {},
          controller: w.isController(),
          isReady: w.ready,
          features: {},
        };
      }
      result[visibleRoom.name] = entries;
    }
    return result;
  }

  /** Propagate an authoritative state change to every *other* watcher in the room. */
  forcePositionUpdate(
    room: Room,
    origin: Watcher,
    change: { position: number; paused: boolean; doSeek: boolean },
  ): void {
    for (const w of room.watchers.values()) {
      if (w === origin) continue;
      w.connection.forceState(change.doSeek);
    }
  }
}
