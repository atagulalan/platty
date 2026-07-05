// Client-side protocol handling. Mirrors SyncClientProtocol - see
// ../../../spec/protocol/handshake-and-version-negotiation.md,
// ../../../spec/protocol/state-sync-and-flow-control.md and
// ../../../spec/protocol/ping-and-latency.md.

import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { connect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { LineProtocol } from "../protocol/wire.js";
import { PingService } from "../protocol/pingService.js";
import { ProtocolError } from "../protocol/errors.js";
import { CONNECT_TIMEOUT_MS, LINE_DELIMITER, MAX_LINE_LENGTH } from "../protocol/constants.js";
import { outgoingHelloVersion, outgoingRealVersion, resolvePeerVersion, inferFeatures, type FeatureFlags } from "../protocol/version.js";
import type { Envelope, FileInfo, PingBlock, IgnoringOnTheFly, SetUserEntry } from "../protocol/types.js";

export interface ClientConnectionEvents {
  hello: [{ username: string; room: string; motd: string; features: FeatureFlags; serverVersion: string }];
  userEvent: [string, SetUserEntry];
  list: [Envelope["List"]];
  state: [
    {
      position: number | undefined;
      paused: boolean | undefined;
      doSeek: boolean;
      setBy: string | null;
      messageAge: number;
    },
  ];
  chat: [string, string];
  playlistChange: [string | undefined, string[]];
  playlistIndex: [string | undefined, number];
  controllerAuthStatus: [string, string, boolean];
  newControlledRoom: [string, string];
  readyUpdate: [string, boolean, boolean, string | undefined];
  error: [string];
  close: [];
}

export interface HelloParams {
  username: string;
  password?: string;
  room: string;
}

export class ConnectionAborted extends Error {
  constructor() {
    super("Connection aborted");
    this.name = "ConnectionAborted";
  }
}

export class ClientConnection extends EventEmitter {
  private wire: LineProtocol | null = null;
  private socket: Socket | null = null;

  private clientIgnoringOnTheFly = 0;
  private serverIgnoringOnTheFly = 0;
  private readonly pingService = new PingService();
  private lastLatencyCalculation = 0;

  private hello: HelloParams | null = null;
  private connected = false;
  private pendingConnectAbort: (() => void) | null = null;

  abortPendingConnect(): void {
    this.pendingConnectAbort?.();
    this.pendingConnectAbort = null;
  }

  connect(host: string, port: number, hello: HelloParams): Promise<void> {
    this.hello = hello;
    this.abortPendingConnect();
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port });
      this.socket = socket;

      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimeout);
        this.pendingConnectAbort = null;
        fn();
      };

      this.pendingConnectAbort = (): void => {
        socket.destroy();
        finish(() => reject(new ConnectionAborted()));
      };

      const connectTimeout = setTimeout(() => {
        socket.destroy();
        const err = new Error(`Connection to ${host}:${port} timed out after ${CONNECT_TIMEOUT_MS}ms`);
        finish(() => reject(err));
      }, CONNECT_TIMEOUT_MS);

      const onError = (err: Error): void => {
        finish(() => reject(err));
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.removeListener("error", onError);
        void this.onTcpConnected(host, socket, finish, resolve, reject);
      });
    });
  }

  private attachWire(socket: Socket): void {
    const wire = new LineProtocol(socket);
    this.wire = wire;
    wire.on("message", (m) => this.handleMessage(m));
    wire.on("jsonError", () => this.emit("error", "Not a json encoded string"));
    wire.on("decodeError", () => this.emit("error", "Not a utf-8 string"));
    wire.on("close", () => {
      this.connected = false;
      this.emit("close");
    });
  }

  private async onTcpConnected(
    host: string,
    socket: Socket,
    finish: (fn: () => void) => void,
    resolve: () => void,
    reject: (err: Error) => void,
  ): Promise<void> {
    try {
      const transport = await this.negotiateTransport(host, socket);
      this.socket = transport;
      this.attachWire(transport);
      this.sendHello();
      finish(() => resolve());
    } catch (err) {
      if (err instanceof ConnectionAborted) finish(() => reject(err));
      else finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  }

  /** In-band STARTTLS negotiation — must complete before Hello on TLS-enabled servers. */
  private negotiateTransport(host: string, socket: Socket): Promise<Socket> {
    const delimiter = Buffer.from(LINE_DELIMITER, "utf8");
    return new Promise((resolve, reject) => {
      socket.write(JSON.stringify({ TLS: { startTLS: "send" } }) + LINE_DELIMITER, "utf8");

      let buf = Buffer.alloc(0);
      const cleanup = (): void => {
        socket.off("data", onData);
        socket.off("error", onErr);
        socket.off("close", onClose);
      };
      const onErr = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error("Connection closed during TLS negotiation"));
      };
      const onData = (chunk: Buffer): void => {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf(delimiter);
        if (idx === -1) {
          if (buf.length > MAX_LINE_LENGTH) {
            cleanup();
            reject(new Error("TLS negotiation line too long"));
          }
          return;
        }
        const line = buf.subarray(0, idx).toString("utf8").trim();
        const remainder = buf.subarray(idx + delimiter.length);
        cleanup();
        if (!line) {
          resolve(socket);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          resolve(socket);
          return;
        }
        const startTls = (parsed as Envelope).TLS?.startTLS;
        if (startTls !== undefined && String(startTls).includes("true")) {
          socket.removeAllListeners("data");
          socket.removeAllListeners("error");
          socket.removeAllListeners("close");
          const tlsSocket = tlsConnect({ socket, servername: host, rejectUnauthorized: true });
          if (remainder.length) tlsSocket.unshift(remainder);
          tlsSocket.once("error", (err) => reject(err));
          tlsSocket.once("secureConnect", () => resolve(tlsSocket));
        } else {
          resolve(socket);
        }
      };
      socket.on("data", onData);
      socket.once("error", onErr);
      socket.once("close", onClose);
    });
  }

  disconnect(): void {
    this.abortPendingConnect();
    this.wire?.close();
  }

  destroy(): void {
    this.abortPendingConnect();
    this.wire?.destroy();
    this.wire = null;
    this.socket = null;
    this.connected = false;
  }

  private sendHello(): void {
    if (!this.hello) return;
    const passwordHash = this.hello.password
      ? createHash("md5").update(this.hello.password, "utf8").digest("hex")
      : undefined;
    this.wire?.send({
      Hello: {
        username: this.hello.username,
        ...(passwordHash ? { password: passwordHash } : {}),
        room: { name: this.hello.room },
        version: outgoingHelloVersion(),
        realversion: outgoingRealVersion(),
        features: {
          sharedPlaylists: true,
          chat: true,
          uiMode: "CLI",
          featureList: true,
          readiness: true,
          managedRooms: true,
          persistentRooms: true,
          setOthersReadiness: true,
        },
      },
    });
  }

  private handleMessage(envelope: Envelope): void {
    if (envelope.Error) {
      this.emit("error", envelope.Error.message);
      return;
    }

    const isKnownCommand =
      envelope.Hello !== undefined ||
      envelope.Set !== undefined ||
      envelope.List !== undefined ||
      envelope.State !== undefined ||
      envelope.Chat !== undefined ||
      envelope.TLS !== undefined;
    if (!isKnownCommand) {
      // Mirrors protocols.py's dropWithError() on an unrecognized top-level command key.
      this.emit("error", ProtocolError.unknownCommand(JSON.stringify(envelope)));
      this.destroy();
      return;
    }

    if (envelope.Hello) this.handleHello(envelope.Hello);
    if (envelope.Set) this.handleSet(envelope.Set);
    if (envelope.List !== undefined) this.emit("list", envelope.List);
    if (envelope.State) this.handleState(envelope.State);
    if (envelope.Chat !== undefined && typeof envelope.Chat === "object") {
      this.emit("chat", envelope.Chat.username, envelope.Chat.message);
    }
  }

  private handleHello(hello: NonNullable<Envelope["Hello"]>): void {
    this.connected = true;
    const serverVersion = resolvePeerVersion(hello);
    const inferred = inferFeatures(serverVersion);
    const explicit = (hello.features ?? {}) as Partial<Record<keyof FeatureFlags, boolean>>;
    const features: FeatureFlags = { ...inferred, ...stripUndefined(explicit) };
    this.emit("hello", {
      username: hello.username,
      room: hello.room?.name ?? "",
      motd: hello.motd ?? "",
      features,
      serverVersion,
    });
  }

  private handleSet(set: NonNullable<Envelope["Set"]>): void {
    if (set.user) {
      for (const [name, entry] of Object.entries(set.user)) this.emit("userEvent", name, entry);
    }
    if (set.controllerAuth && "success" in set.controllerAuth) {
      this.emit("controllerAuthStatus", set.controllerAuth.user, set.controllerAuth.room, set.controllerAuth.success);
    }
    if (set.newControlledRoom) {
      this.emit("newControlledRoom", set.newControlledRoom.password, set.newControlledRoom.roomName);
    }
    if (set.ready && "username" in set.ready) {
      const ready = set.ready as { username: string; isReady: boolean; manuallyInitiated: boolean; setBy?: string };
      this.emit("readyUpdate", ready.username, ready.isReady, ready.manuallyInitiated, ready.setBy);
    }
    if (set.playlistChange) {
      const pc = set.playlistChange as { user?: string; files: string[] };
      this.emit("playlistChange", pc.user, pc.files);
    }
    if (set.playlistIndex) {
      const pi = set.playlistIndex as { user?: string; index: number };
      this.emit("playlistIndex", pi.user, pi.index);
    }
  }

  // ---- State / ping / ignoringOnTheFly -------------------------------------------------------

  private handleState(state: NonNullable<Envelope["State"]>): void {
    const ignore = state.ignoringOnTheFly;
    if (ignore?.server !== undefined) {
      this.serverIgnoringOnTheFly = ignore.server;
      this.clientIgnoringOnTheFly = 0; // a server ack implicitly clears our own pending flag too
    }
    if (ignore?.client !== undefined && ignore.client === this.clientIgnoringOnTheFly) {
      this.clientIgnoringOnTheFly = 0;
    }

    const ping = state.ping;
    this.lastLatencyCalculation = ping?.latencyCalculation ?? 0;
    let messageAge = 0;
    if (ping?.clientLatencyCalculation !== undefined && ping.serverRtt !== undefined) {
      this.pingService.receiveMessage(ping.clientLatencyCalculation, ping.serverRtt);
      messageAge = this.pingService.getLastForwardDelay();
    }

    if (this.clientIgnoringOnTheFly !== 0) return; // still waiting for our own change to be acked

    const playstate = state.playstate;
    if (playstate?.position === undefined || playstate.paused === undefined) return;
    this.emit("state", {
      position: playstate.position,
      paused: playstate.paused,
      doSeek: !!playstate.doSeek,
      setBy: playstate.setBy ?? null,
      messageAge,
    });
  }

  /**
   * Send our current state. `stateChange=true` means this is a self-initiated pause/seek (not a
   * reaction to an incoming server message) - increments clientIgnoringOnTheFly per
   * spec/protocol/state-sync-and-flow-control.md.
   */
  sendState(position: number, paused: boolean, doSeek: boolean, stateChange: boolean): void {
    // Evaluate inclusion BEFORE incrementing: the message that announces a fresh self-initiated
    // change must still carry its own playstate (that's the whole point of sending it) - it's
    // only *subsequent* sends, while still waiting for the server to ack this counter value,
    // that suppress playstate. Incrementing first would suppress the announcement itself.
    const includePlaystate = this.clientIgnoringOnTheFly === 0 || this.serverIgnoringOnTheFly !== 0;
    if (stateChange) this.clientIgnoringOnTheFly += 1;

    const ping: PingBlock = {
      latencyCalculation: this.lastLatencyCalculation,
      clientLatencyCalculation: this.pingService.newTimestamp(),
      clientRtt: this.pingService.getRtt(),
    };

    const ignoringOnTheFly: IgnoringOnTheFly = {};
    if (this.serverIgnoringOnTheFly) {
      ignoringOnTheFly.server = this.serverIgnoringOnTheFly;
      this.serverIgnoringOnTheFly = 0; // one-shot forward of the acknowledgment
    }
    if (this.clientIgnoringOnTheFly) ignoringOnTheFly.client = this.clientIgnoringOnTheFly;

    this.wire?.send({
      State: {
        ping,
        ...(includePlaystate ? { playstate: { position, paused, ...(doSeek ? { doSeek } : {}) } } : {}),
        ...(Object.keys(ignoringOnTheFly).length ? { ignoringOnTheFly } : {}),
      },
    });
  }

  sendRoom(name: string, password?: string): void {
    this.wire?.send({ Set: { room: { name, ...(password ? { password } : {}) } } });
  }

  sendFile(file: FileInfo): void {
    this.wire?.send({ Set: { file } });
    this.wire?.send({ List: null });
  }

  sendReady(isReady: boolean, manuallyInitiated: boolean, username?: string): void {
    this.wire?.send({ Set: { ready: { isReady, manuallyInitiated, ...(username ? { username } : {}) } } });
  }

  sendPlaylist(files: string[]): void {
    this.wire?.send({ Set: { playlistChange: { files } } });
  }

  sendPlaylistIndex(index: number): void {
    this.wire?.send({ Set: { playlistIndex: { index } } });
  }

  requestControllerAuth(room: string, password: string): void {
    this.wire?.send({ Set: { controllerAuth: { room, password } } });
  }

  requestList(): void {
    this.wire?.send({ List: null });
  }

  sendChat(message: string): void {
    this.wire?.send({ Chat: message });
  }

  get isConnected(): boolean {
    return this.connected;
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

export declare interface ClientConnection {
  on<K extends keyof ClientConnectionEvents>(event: K, listener: (...args: ClientConnectionEvents[K]) => void): this;
  emit<K extends keyof ClientConnectionEvents>(event: K, ...args: ClientConnectionEvents[K]): boolean;
}
