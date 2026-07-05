// Server-side per-connection protocol handling. Mirrors SyncServerProtocol in
// ../../spec/protocol/*.md (handshake, state-sync-and-flow-control, ping-and-latency,
// message-reference) and the room/permission logic in ../../spec/server/*.md.

import type { Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { LineProtocol } from "../protocol/wire.js";
import { PingService } from "../protocol/pingService.js";
import { ProtocolError } from "../protocol/errors.js";
import {
  outgoingHelloVersion,
  outgoingRealVersion,
  resolvePeerVersion,
  inferFeatures,
  type FeatureFlags,
} from "../protocol/version.js";
import {
  isControlledRoomName,
  parseControlledRoomName,
  checkControlPassword,
  getControlledRoomName,
} from "../protocol/roomPassword.js";
import {
  MAX_CHAT_MESSAGE_LENGTH,
  MAX_FILENAME_LENGTH,
  MAX_ROOM_NAME_LENGTH,
  MAX_USERNAME_LENGTH,
  PLAYLIST_MAX_CHARACTERS,
  PLAYLIST_MAX_ITEMS,
  PROTOCOL_TIMEOUT_MS,
  SERVER_STATE_INTERVAL_MS,
} from "../protocol/constants.js";
import type { Envelope, FileInfo, PingBlock, IgnoringOnTheFly } from "../protocol/types.js";
import { Room, ControlledRoom } from "./Room.js";
import { Watcher } from "./Watcher.js";
import type { SyncServer } from "./SyncServer.js";

function truncate(s: string, max: number): string {
  return s.slice(0, max);
}

export class ServerConnection {
  private wire: LineProtocol;
  /** Mutable: reassigned to the wrapping TLSSocket on a successful in-band STARTTLS upgrade. */
  private socket: Socket;
  private logged = false;
  private watcher: Watcher | null = null;
  private clientVersion = "0.0.0";
  private features: FeatureFlags = inferFeatures("0.0.0");

  private readonly pingService = new PingService();
  private clientIgnoringOnTheFly = 0;
  private serverIgnoringOnTheFly = 0;
  private pendingClientLatencyCalculation = 0;
  private clientLatencyCalculationArrivalTime = 0;

  private stateTimer: NodeJS.Timeout | null = null;
  private pendingForcedDoSeek = false;

  constructor(
    private readonly server: SyncServer,
    socket: Socket,
  ) {
    this.socket = socket;
    this.wire = this.bindWire(socket);
  }

  private bindWire(socket: Socket): LineProtocol {
    const wire = new LineProtocol(socket);
    wire.on("message", (m) => this.handleMessage(m));
    wire.on("jsonError", (line) => this.dropWithError(ProtocolError.notJson(line)));
    wire.on("decodeError", () => this.dropWithError(ProtocolError.lineDecode()));
    wire.on("close", () => this.onClose());
    return wire;
  }

  private dropWithError(message: string): void {
    this.wire.send({ Error: { message } });
    this.wire.destroy();
  }

  private onClose(): void {
    if (this.stateTimer) clearInterval(this.stateTimer);
    if (this.watcher) this.server.removeWatcher(this.watcher);
  }

  private requireLogged(handler: () => void): void {
    if (!this.logged) {
      this.dropWithError(ProtocolError.notKnown());
      return;
    }
    handler();
  }

  // ---- dispatch ----------------------------------------------------------

  private handleMessage(envelope: Envelope): void {
    if (envelope.TLS) {
      this.handleTLS(envelope.TLS);
      return;
    }
    if (envelope.Hello) {
      this.handleHello(envelope.Hello);
      return;
    }
    if (envelope.Chat !== undefined) {
      this.requireLogged(() => this.handleChat(envelope.Chat as string));
    }
    if (envelope.Set) {
      this.requireLogged(() => this.handleSet(envelope.Set!));
    }
    if (envelope.List !== undefined) {
      this.requireLogged(() => this.handleList());
    }
    if (envelope.State) {
      this.requireLogged(() => this.handleState(envelope.State!));
    }
  }

  /**
   * In-band STARTTLS (spec/protocol/handshake-and-version-negotiation.md#tls-handshake). Only
   * valid pre-Hello, matching the reference server (`protocols.py:796`: `not self.isLogged() and
   * self._factory.serverAcceptsTLS`) - past that point (or with no --tls configured) we always
   * decline, exactly as before.
   *
   * Caveat: swapping the live transport mid-connection from a plaintext `net.Socket` to a
   * `tls.TLSSocket` isn't a first-class operation this codebase's wire framing
   * (`../protocol/wire.ts`) was designed for, and that file is out of scope to modify for this
   * change. We work around it from the outside: detach `LineProtocol`'s raw `data`/`close`/`error`
   * listeners from the plaintext socket (plain `EventEmitter` API, no wire.ts changes needed),
   * wrap the same socket in a `TLSSocket` in server mode, and rebind a fresh `LineProtocol` around
   * it. This has been sanity-checked structurally (listener handoff, reply-before-upgrade
   * ordering) but not against a real TLS-capable Syncplay client in this environment - treat the
   * upgrade path as best-effort. The --tls-absent case is untouched and behaves exactly as before.
   */
  private handleTLS(tls: { startTLS: string }): void {
    if (tls.startTLS !== "send") return;
    const creds = this.server.tlsCredentials;
    if (this.logged || !creds) {
      this.wire.send({ TLS: { startTLS: "false" } });
      return;
    }
    // Reply in the clear first (per spec, the ack itself precedes the encrypted handshake), then
    // upgrade the transport before any further bytes arrive.
    this.wire.send({ TLS: { startTLS: "true" } });
    this.upgradeToTls(creds);
  }

  private upgradeToTls(creds: { cert: Buffer; key: Buffer }): void {
    const plainSocket = this.socket;
    plainSocket.removeAllListeners("data");
    plainSocket.removeAllListeners("close");
    plainSocket.removeAllListeners("error");

    const tlsSocket = new TLSSocket(plainSocket, {
      isServer: true,
      cert: creds.cert,
      key: creds.key,
    });
    tlsSocket.on("error", () => {
      /* the wrapped LineProtocol's 'close' listener (bound below) handles cleanup */
    });

    this.socket = tlsSocket;
    this.wire = this.bindWire(tlsSocket);
  }

  // ---- Hello / handshake --------------------------------------------------

  private handleHello(hello: Envelope["Hello"]): void {
    if (!hello || !hello.username || !hello.room?.name || !(hello.version || hello.realversion)) {
      this.dropWithError(ProtocolError.hello());
      return;
    }
    if (this.server.password) {
      const suppliedHash = hello.password ?? "";
      if (!hello.password) {
        this.dropWithError(ProtocolError.passwordRequired());
        return;
      }
      if (suppliedHash !== this.server.password) {
        this.dropWithError(ProtocolError.wrongPassword());
        return;
      }
    }

    this.clientVersion = resolvePeerVersion({
      version: hello.version,
      realversion: hello.realversion,
    });
    this.features = inferFeatures(this.clientVersion);

    const username = this.server.roomManager.findFreeUsername(
      truncate(hello.username.trim(), MAX_USERNAME_LENGTH),
      MAX_USERNAME_LENGTH,
    );
    const roomName = truncate(hello.room.name.trim(), MAX_ROOM_NAME_LENGTH);
    const room = this.server.roomManager.getOrCreateRoom(roomName);

    this.watcher = new Watcher(this, username, room);
    room.addWatcher(this.watcher);
    this.logged = true;

    const motd = this.server.renderMotdFor(username, roomName, this.socket.remoteAddress ?? "", this.clientVersion);

    this.wire.send({
      Hello: {
        username,
        room: { name: roomName },
        version: outgoingHelloVersion(),
        realversion: outgoingRealVersion(),
        features: this.server.getFeatures(),
        motd,
      },
    });

    // Announce the join to everyone who can see this room, then push current room state.
    this.server.broadcastUserEvent(this.watcher, { joined: true, version: this.clientVersion });
    this.pushRoomStateToSelf(false);

    this.stateTimer = setInterval(() => this.tick(), SERVER_STATE_INTERVAL_MS);
  }

  // ---- Chat -----------------------------------------------------------------

  private handleChat(message: string): void {
    if (this.server.disableChat || !this.watcher) return;
    const truncated = truncate(message, this.server.maxChatMessageLength);
    this.server.broadcastChat(this.watcher, truncated);
  }

  receiveChat(from: string, message: string): void {
    this.wire.send({ Chat: { username: from, message } });
  }

  // ---- Set --------------------------------------------------------------

  private handleSet(set: NonNullable<Envelope["Set"]>): void {
    if (!this.watcher) return;
    if (set.room) this.handleSetRoom(set.room);
    if (set.file) this.handleSetFile(set.file);
    if (set.controllerAuth) this.handleControllerAuth(set.controllerAuth as { room: string; password: string });
    if (set.ready) this.handleSetReady(set.ready as { isReady: boolean; manuallyInitiated: boolean; username?: string });
    if (set.playlistChange) this.handleSetPlaylist(set.playlistChange as { files: string[] });
    if (set.playlistIndex) this.handleSetPlaylistIndex(set.playlistIndex as { index: number });
    // set.features: intentionally unvalidated no-op, matching the reference server's `# TODO: Check`.
  }

  private handleSetRoom(room: { name: string; password?: string }): void {
    if (!this.watcher) return;
    const newName = truncate(room.name.trim(), MAX_ROOM_NAME_LENGTH);
    this.server.moveWatcherToRoom(this.watcher, newName);
    this.pushRoomStateToSelf(false);
  }

  private handleSetFile(file: FileInfo): void {
    if (!this.watcher) return;
    this.watcher.file = { ...file, name: truncate(file.name, MAX_FILENAME_LENGTH) };
    this.server.broadcastUserEvent(this.watcher, undefined);
  }

  private handleControllerAuth(req: { room: string; password: string }): void {
    if (!this.watcher) return;
    const salt = this.server.salt;
    const targetRoomName = req.room || this.watcher.room.name;

    if (isControlledRoomName(targetRoomName)) {
      const success = checkControlPassword(targetRoomName, req.password, salt);
      if (success) {
        const room = this.server.roomManager.getOrCreateRoom(targetRoomName);
        if (room instanceof ControlledRoom) room.addController(this.watcher.name);
      }
      this.server.broadcastControllerAuthStatus(this.watcher.name, targetRoomName, success);
    } else {
      // NotControlledRoom: client wants to turn a plain room name into a controlled one.
      const canonical = getControlledRoomName(targetRoomName, req.password, salt);
      this.wire.send({ Set: { newControlledRoom: { password: req.password, roomName: canonical } } });
    }
  }

  private handleSetReady(req: { isReady: boolean; manuallyInitiated: boolean; username?: string }): void {
    if (!this.watcher || this.server.disableReady) return;
    let target = this.watcher;
    let setBy: string | undefined;
    if (req.username && req.username !== this.watcher.name && this.watcher.room.canControl(this.watcher)) {
      const other = this.watcher.room.watchers.get(req.username);
      if (!other) return;
      target = other;
      setBy = this.watcher.name;
    }
    target.ready = req.isReady;
    this.server.broadcastReady(target, req.manuallyInitiated, setBy);
  }

  private handleSetPlaylist(req: { files: string[] }): void {
    if (!this.watcher) return;
    const room = this.watcher.room;
    const valid =
      req.files.length <= PLAYLIST_MAX_ITEMS &&
      req.files.reduce((n, f) => n + f.length, 0) <= PLAYLIST_MAX_CHARACTERS;

    if (valid && room.canControl(this.watcher)) {
      room.playlist = req.files;
      this.server.broadcastPlaylistChange(room, this.watcher.name);
    } else {
      // Silently revert the sender to the room's authoritative playlist.
      this.wire.send({ Set: { playlistChange: { user: this.watcher.name, files: room.playlist } } });
    }
  }

  private handleSetPlaylistIndex(req: { index: number }): void {
    if (!this.watcher) return;
    const room = this.watcher.room;
    if (room.canControl(this.watcher)) {
      room.playlistIndex = req.index;
      this.server.broadcastPlaylistIndex(room, this.watcher.name);
    } else {
      this.wire.send({
        Set: { playlistIndex: { user: this.watcher.name, index: room.playlistIndex ?? 0 } },
      });
    }
  }

  // ---- List ---------------------------------------------------------------

  private handleList(): void {
    if (!this.watcher) return;
    this.wire.send({ List: this.server.buildListFor(this.watcher.room) });
  }

  // ---- State / ping / ignoringOnTheFly -------------------------------------

  private handleState(state: NonNullable<Envelope["State"]>): void {
    if (!this.watcher) return;
    this.watcher.touch();

    const ignore = state.ignoringOnTheFly;
    if (ignore?.server !== undefined && ignore.server === this.serverIgnoringOnTheFly) {
      this.serverIgnoringOnTheFly = 0;
    }
    if (ignore?.client !== undefined) {
      // Unconditional adoption - deliberately asymmetric vs. the `server` field above.
      this.clientIgnoringOnTheFly = ignore.client;
    }

    const ping = state.ping;
    const latencyCalculation = ping?.latencyCalculation ?? 0;
    const clientRtt = ping?.clientRtt ?? 0;
    this.pendingClientLatencyCalculation = ping?.clientLatencyCalculation ?? 0;
    this.clientLatencyCalculationArrivalTime = Date.now() / 1000;
    this.pingService.receiveMessage(latencyCalculation, clientRtt);

    if (this.serverIgnoringOnTheFly === 0 && state.playstate) {
      const { position, paused, doSeek } = state.playstate;
      if (position !== undefined && paused !== undefined) {
        const messageAge = this.pingService.getLastForwardDelay();
        const compensated = paused ? position : position + messageAge;

        const room = this.watcher.room;
        if (room.canControl(this.watcher)) {
          // Only a *meaningful* transition (derived room pause state actually flipping, or an
          // explicit seek) is treated as authoritative and force-broadcast to the room. A
          // routine per-second heartbeat that reports the same state the room already has must
          // NOT overwrite room.setBy / force-push everyone else - otherwise the last client to
          // tick would constantly stomp on whoever just made a real change (this was a real bug
          // caught by the smoke test: Bob's idle heartbeat kept reverting Alice's unpause).
          const previouslyPaused = room.isPaused();
          this.watcher.position = compensated;
          this.watcher.paused = paused;
          room.position = room.getPosition();
          const nowPaused = room.isPaused();
          const meaningfulChange = doSeek || nowPaused !== previouslyPaused;

          if (meaningfulChange) {
            room.paused = nowPaused;
            room.setBy = this.watcher.name;
            this.server.forcePositionUpdate(room, this.watcher, { position: compensated, paused: nowPaused, doSeek: !!doSeek });
          }
        } else {
          // Non-controller in a managed room: revert them to the authoritative state.
          this.sendState(true);
        }
      }
    }
  }

  /** Called by SyncServer.forcePositionUpdate() for every *other* watcher in the room. */
  forceState(doSeek: boolean): void {
    this.serverIgnoringOnTheFly += 1;
    this.pendingForcedDoSeek = doSeek;
    this.sendState(true);
  }

  private tick(): void {
    if (!this.watcher) return;
    if (Date.now() - this.watcher.lastUpdatedOn > PROTOCOL_TIMEOUT_MS) {
      this.server.removeWatcher(this.watcher);
      this.wire.destroy();
      return;
    }
    this.sendState(false);
  }

  private sendState(forced: boolean): void {
    if (!this.watcher) return;
    if (this.serverIgnoringOnTheFly !== 0 && !forced) return; // withhold the entire message

    const room = this.watcher.room;
    const ping: PingBlock = {
      latencyCalculation: this.pingService.newTimestamp(),
      serverRtt: this.pingService.getRtt(),
    };
    if (this.pendingClientLatencyCalculation !== 0) {
      const processingTime = Date.now() / 1000 - this.clientLatencyCalculationArrivalTime;
      ping.clientLatencyCalculation = this.pendingClientLatencyCalculation + processingTime;
      this.pendingClientLatencyCalculation = 0;
    }

    const ignoringOnTheFly: IgnoringOnTheFly = {};
    if (this.serverIgnoringOnTheFly) ignoringOnTheFly.server = this.serverIgnoringOnTheFly;
    if (this.clientIgnoringOnTheFly) {
      ignoringOnTheFly.client = this.clientIgnoringOnTheFly;
      this.clientIgnoringOnTheFly = 0;
    }

    this.wire.send({
      State: {
        ping,
        playstate: {
          position: room.getPosition(),
          paused: room.isPaused(),
          doSeek: forced ? this.pendingForcedDoSeek : false,
          setBy: room.setBy,
        },
        ...(Object.keys(ignoringOnTheFly).length ? { ignoringOnTheFly } : {}),
      },
    });
  }

  // ---- helpers used by SyncServer -----------------------------------------

  meetsFeature(flag: keyof FeatureFlags): boolean {
    return this.features[flag];
  }

  pushRoomStateToSelf(fromRemoteUser: boolean): void {
    if (!this.watcher) return;
    const room = this.watcher.room;
    // Re-send controller-auth-status for the room's existing controllers to this watcher only,
    // on both initial join and room switch - matches the reference server's setWatcherRoom()
    // (server.py:118-145), which does this unconditionally regardless of asJoin. See
    // spec/server/rooms-and-permissions.md#room-lifecycle.
    this.server.sendControllerAuthStatusToWatcher(this.watcher);
    // Omitting "user" signals "this is the room's current state", not a remote user's edit -
    // the reference client's reconnection logic keys off exactly this distinction (see
    // spec/client/reconnection-and-resilience.md#playlist-restoration).
    if (!fromRemoteUser) {
      const playlistChange: { files: string[]; user?: string } = { files: room.playlist };
      if (room.setBy) playlistChange.user = room.setBy;
      this.wire.send({ Set: { playlistChange } });
      if (room.playlistIndex !== null) {
        const playlistIndex: { index: number; user?: string } = { index: room.playlistIndex };
        if (room.setBy) playlistIndex.user = room.setBy;
        this.wire.send({ Set: { playlistIndex } });
      }
    }
  }

  sendEnvelope(envelope: Envelope): void {
    this.wire.send(envelope);
  }

  get username(): string | undefined {
    return this.watcher?.name;
  }

  /** For --stats-db-file's version histogram (see SyncServer.recordStatsSnapshot). */
  get peerVersion(): string {
    return this.clientVersion;
  }
}
