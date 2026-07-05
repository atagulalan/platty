// Newline-delimited JSON framing over a raw TCP socket.
// Mirrors Twisted's LineReceiver defaults exactly - see ../../../spec/protocol/wire-format.md.
//
// - delimiter: "\r\n" (never configurable in the reference implementation, so neither is this)
// - max line length: 16384 bytes; exceeding it silently closes the connection (no Error frame)
// - a line is a JSON object whose top-level keys are command names (Hello/Set/List/State/Error/Chat/TLS)
// - invalid UTF-8 must be rejected (not silently replaced) - Node's socket.setEncoding("utf8")
//   would silently substitute U+FFFD instead, so we buffer raw bytes and decode with a
//   fatal TextDecoder ourselves.

import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { LINE_DELIMITER, MAX_LINE_LENGTH } from "./constants.js";
import type { Envelope } from "./types.js";

export interface LineProtocolEvents {
  message: [Envelope];
  decodeError: []; // "Not a utf-8 string" - caller should dropWithError
  jsonError: [string]; // "Not a json encoded string {}" - caller should dropWithError
  lineTooLong: [];
  close: [];
}

const DELIMITER_BYTES = Buffer.from(LINE_DELIMITER, "utf8");
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Emits a typed 'message' event per parsed JSON line; call send() to write one out. */
export class LineProtocol extends EventEmitter {
  private buffer: Buffer = Buffer.alloc(0);
  private closed = false;

  constructor(private readonly socket: Socket) {
    super();
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("close", () => {
      this.closed = true;
      this.emit("close");
    });
    socket.on("error", () => {
      /* 'close' follows; nothing extra to do here */
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const idx = this.buffer.indexOf(DELIMITER_BYTES);
      if (idx === -1) {
        if (this.buffer.length > MAX_LINE_LENGTH) {
          this.emit("lineTooLong");
          this.socket.destroy(); // Twisted's default lineLengthExceeded(): silent disconnect
        }
        return;
      }
      const lineBytes = this.buffer.subarray(0, idx);
      this.buffer = this.buffer.subarray(idx + DELIMITER_BYTES.length);
      if (lineBytes.length > MAX_LINE_LENGTH) {
        this.emit("lineTooLong");
        this.socket.destroy(); // Twisted's default lineLengthExceeded(): silent disconnect
        return;
      }
      this.handleLine(lineBytes);
      if (this.closed) return;
    }
  }

  private handleLine(lineBytes: Buffer): void {
    let decoded: string;
    try {
      decoded = strictUtf8.decode(lineBytes);
    } catch {
      this.emit("decodeError");
      return;
    }
    const line = decoded.trim();
    if (line.length === 0) return; // silently ignored, per spec

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emit("jsonError", line);
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      this.emit("jsonError", line);
      return;
    }
    this.emit("message", parsed as Envelope);
  }

  send(envelope: Envelope): void {
    if (this.closed) return;
    this.socket.write(JSON.stringify(envelope) + LINE_DELIMITER, "utf8");
  }

  close(): void {
    this.socket.end();
  }

  destroy(): void {
    this.socket.destroy();
  }
}

export declare interface LineProtocol {
  on<K extends keyof LineProtocolEvents>(
    event: K,
    listener: (...args: LineProtocolEvents[K]) => void,
  ): this;
  emit<K extends keyof LineProtocolEvents>(event: K, ...args: LineProtocolEvents[K]): boolean;
}
