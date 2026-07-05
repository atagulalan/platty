// VLC integration via the bundled `syncplay.lua` interface script (copied verbatim from the
// reference project's resources/lua/intf/syncplay.lua - see resources/syncplay.lua in this repo
// and the attribution below). See ../../spec/players/vlc.md for the full command vocabulary
// and the platform-specific Lua interface install paths this mirrors.

import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { connect, type Socket } from "node:net";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { platform } from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { DisplayMessageOptions, Player, PlayerFileInfo } from "./BasePlayer.js";

// Attribution: syncplay.lua is authored by Etoh and contributors, from the Syncplay project
// (https://syncplay.pl/, Apache 2.0), reused here unmodified.
const __dirname = dirname(fileURLToPath(import.meta.url));
const LUA_SCRIPT_PATH = join(__dirname, "..", "..", "resources", "syncplay.lua");

function luaInterfaceUserDir(): string {
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "org.videolan.vlc", "lua", "intf");
  if (platform === "win32") return join(process.env.APPDATA ?? homedir(), "vlc", "lua", "intf");
  return join(homedir(), ".local", "share", "vlc", "lua", "intf");
}

function installLuaScript(): void {
  const dir = luaInterfaceUserDir();
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, "syncplay.lua");
  if (!existsSync(dest)) copyFileSync(LUA_SCRIPT_PATH, dest);
}

function randomPort(): number {
  return 10000 + Math.floor(Math.random() * 45000);
}

// spec/players/vlc.md / source/syncplay/constants.py.
const VLC_MIN_VERSION = "2.2.1";
const VLC_EOF_DURATION_THRESHOLD = 2.0; // seconds
const PLAYLIST_LOAD_NEXT_FILE_MINIMUM_LENGTH = 10; // seconds
const VLC_VERSION_CHECK_TIMEOUT_MS = 5000;
const VLC_RECONNECT_ATTEMPTS = 10;

/** Simple dotted-version >= comparison (e.g. "3.0.9" >= "2.2.1"). Missing components compare as 0. */
function meetsMinVersion(version: string, minVersion: string): boolean {
  const toParts = (v: string): number[] => v.split(".").map((p) => parseInt(p, 10) || 0);
  const vParts = toParts(version);
  const mParts = toParts(minVersion);
  for (let i = 0; i < Math.max(vParts.length, mParts.length); i++) {
    const a = vParts[i] ?? 0;
    const b = mParts[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

export class VlcPlayer extends EventEmitter implements Player {
  readonly name = "vlc";
  readonly speedSupported = false;
  readonly alertOsdSupported = false;
  readonly osdMessageSeparator = "; "; // reference client treats VLC rate changes as unreliable; we skip slowdown for VLC

  private process: ChildProcessWithoutNullStreams | null = null;
  private socket: Socket | null = null;
  private buffer = "";
  private pollTimer: NodeJS.Timeout | null = null;

  private lastPaused = true;
  private lastPosition = 0;
  private lastDuration = 0;
  private lastFilepath = "";
  private fileAnnounced = false;

  /** Set by quit() so an unexpected socket 'close' (VLC crashed/closed) can be told apart from a
   * deliberate shutdown - only the former triggers reconnect-then-give-up-and-emit-close logic. */
  private manualQuit = false;

  private vlcVersion: string | null = null;
  private vlcVersionResolve: (() => void) | null = null;
  private vlcVersionReject: ((err: Error) => void) | null = null;

  /** Last two raw position readings, used for the EOF-stuck-as-paused workaround (unchanged
   * position across polls near the file's duration). Newest last. */
  private recentPositions: number[] = [];

  /** Last emitted status, for duplicate-position suppression in emitStatus(). */
  private lastEmittedPaused: boolean | null = null;
  private lastEmittedPosition: number | null = null;

  constructor(private readonly vlcPath = "vlc") {
    super();
  }

  async open(filePath: string): Promise<void> {
    if (this.process) {
      this.send(`load-file: ${filePath}`);
      return;
    }

    installLuaScript();
    const port = randomPort();

    const proc = spawn(this.vlcPath, [
      filePath,
      "--extraintf=luaintf",
      "--lua-intf=syncplay",
      `--lua-config=syncplay={port="${port}"}`,
      "--no-quiet",
      "--no-input-fast-seek",
      "--play-and-pause",
      "--start-time=0",
    ]);
    this.process = proc;
    proc.on("exit", () => this.emit("close"));
    proc.on("error", (err) => this.emit("error", err));

    await this.connectWithRetry(port);
    this.requestInitialState();
    this.pollTimer = setInterval(() => this.send("."), 500);

    // Gate on VLC's version reply (handleLine's "vlc-version" case resolves/rejects this) -
    // mirrors mpv's version gate (mpvPlayer.ts's checkMinimumVersion), but VLC only exposes its
    // version once connected (there's no separate `vlc --version` CLI probe like mpv's).
    try {
      await this.waitForVlcVersionCheck();
    } catch (err) {
      this.manualQuit = true; // suppress reconnect attempts - we're intentionally tearing down.
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.socket?.destroy();
      this.process?.kill();
      throw err;
    }
  }

  private requestInitialState(): void {
    this.send("get-vlc-version");
    this.send("get-duration");
    this.send("get-filepath");
    this.send("get-filename");
  }

  /** Resolves once handleLine sees a "vlc-version" reply and it's new enough; rejects if it's too
   * old. Fails open (resolves) after a timeout if VLC never answers, rather than blocking open()
   * forever - same fail-open philosophy as mpv's version check when parsing fails. */
  private waitForVlcVersionCheck(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.vlcVersionResolve = resolve;
      this.vlcVersionReject = reject;
      setTimeout(() => {
        if (this.vlcVersionResolve) {
          this.vlcVersionResolve = null;
          this.vlcVersionReject = null;
          resolve();
        }
      }, VLC_VERSION_CHECK_TIMEOUT_MS);
    });
  }

  private connectWithRetry(port: number, attemptsLeft = 60): Promise<void> {
    return new Promise((resolve, reject) => {
      const attempt = (): void => {
        const socket = connect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          this.socket = socket;
          socket.setEncoding("utf8");
          socket.on("data", (chunk: string) => this.onData(chunk));
          socket.on("close", () => this.handleUnexpectedClose(port));
          resolve();
        });
        socket.once("error", () => {
          socket.destroy();
          if (attemptsLeft <= 0) {
            reject(new Error(`Could not connect to VLC's syncplay.lua interface on port ${port}`));
            return;
          }
          setTimeout(() => this.connectWithRetry(port, attemptsLeft - 1).then(resolve, reject), 300);
        });
      };
      attempt();
    });
  }

  /** Handles a socket 'close' that wasn't requested by quit(). Attempts a bounded reconnect
   * (reusing connectWithRetry's own attempt loop) before giving up and telling the client VLC is
   * gone. */
  private handleUnexpectedClose(port: number): void {
    this.socket = null;
    if (this.manualQuit) return;
    this.connectWithRetry(port, VLC_RECONNECT_ATTEMPTS)
      .then(() => this.requestInitialState())
      .catch(() => this.emit("close"));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    const colon = line.indexOf(":");
    const key = colon === -1 ? line : line.slice(0, colon).trim();
    const value = colon === -1 ? "" : line.slice(colon + 1).trim();

    switch (key) {
      case "playstate": {
        if (value === "playing" || value === "paused") {
          this.lastPaused = value === "paused";
          this.emitStatus();
        }
        break;
      }
      case "position": {
        const n = Number(value.replace(",", "."));
        if (Number.isNaN(n)) break;

        // VLC 3.0.0 32-bit position-overflow bug (spec/players/vlc.md ~45-47, ~90-92): on long
        // files some platforms report a bogus negative position. Hard-drop this single reading
        // rather than propagating it as a real seek.
        if (n < 0 && this.lastDuration > 2147 && this.vlcVersion === "3.0.0") {
          break;
        }

        // EOF-stuck-as-paused workaround (spec/players/vlc.md ~30-32, ~90-92): VLC can get stuck
        // at EOF and keep reporting "playing" with a static position. Detect via the position
        // being unchanged across the last two polls while near the end of the file, and
        // reinterpret as paused.
        const stuckAtEof =
          !this.lastPaused &&
          this.recentPositions.length === 2 &&
          this.recentPositions[0] === n &&
          this.recentPositions[1] === n &&
          this.lastDuration > PLAYLIST_LOAD_NEXT_FILE_MINIMUM_LENGTH &&
          this.lastDuration - n < VLC_EOF_DURATION_THRESHOLD;

        this.recentPositions.push(n);
        if (this.recentPositions.length > 2) this.recentPositions.shift();

        this.lastPosition = n;
        if (stuckAtEof) this.lastPaused = true;
        this.emitStatus();
        break;
      }
      case "duration":
      case "duration-change": {
        const n = Number(value.replace(",", "."));
        if (!Number.isNaN(n)) {
          this.lastDuration = n;
          this.maybeAnnounceFile();
        }
        break;
      }
      case "filepath":
      case "filepath-change-notification": {
        this.lastFilepath = value;
        this.fileAnnounced = false;
        this.maybeAnnounceFile();
        break;
      }
      case "vlc-version": {
        // syncplay.lua's do_command() replies "vlc-version: <VLC version string>\n" to
        // get-vlc-version (ts/resources/syncplay.lua:497,which is sent from `open()`). The
        // version string may have a trailing codename/suffix (e.g. "3.0.16 Vetinari") - take just
        // the leading dotted-number token, mirroring Python's vlc.py:351 parsing.
        const versionToken = value.split(/\s+/)[0] ?? "";
        this.vlcVersion = versionToken;
        if (versionToken && !meetsMinVersion(versionToken, VLC_MIN_VERSION)) {
          this.vlcVersionReject?.(new Error(`VLC version ${versionToken} is too old for Syncplay - requires VLC >= ${VLC_MIN_VERSION}. Please upgrade VLC.`));
        } else {
          this.vlcVersionResolve?.();
        }
        this.vlcVersionResolve = null;
        this.vlcVersionReject = null;
        break;
      }
    }
  }

  private maybeAnnounceFile(): void {
    if (this.fileAnnounced || !this.lastFilepath || !this.lastDuration) return;
    this.fileAnnounced = true;
    const info: PlayerFileInfo = {
      name: this.lastFilepath.split(/[/\\]/).pop() ?? this.lastFilepath,
      path: this.lastFilepath,
      duration: this.lastDuration,
    };
    this.emit("fileInfo", info);
  }

  private emitStatus(): void {
    // Duplicate-position suppression: skip the emit entirely if neither paused state nor position
    // actually changed since the last emitted status - cuts down redundant no-op events, matching
    // the Python client's dedup behavior (a lighter-weight variant scoped to the emit boundary
    // rather than vlc.py's more elaborate per-line _previousPosition bookkeeping).
    if (this.lastEmittedPaused === this.lastPaused && this.lastEmittedPosition === this.lastPosition) {
      return;
    }
    this.lastEmittedPaused = this.lastPaused;
    this.lastEmittedPosition = this.lastPosition;
    this.emit("status", { paused: this.lastPaused, position: this.lastPosition });
  }

  private send(line: string): void {
    this.socket?.write(line + "\n", "utf8");
  }

  setPaused(paused: boolean): void {
    this.send(`set-playstate: ${paused ? "paused" : "playing"}`);
  }

  setPosition(seconds: number): void {
    // Locale-safe decimal formatting: syncplay.lua's radixsafe_tonumber() (ts/resources/syncplay.lua
    // ~127-149) replaces every non-digit character with "." and then requires the result to match
    // a single-sign/single-dot pattern, i.e. it *tolerates* a locale radix character (comma) by
    // normalizing it - but it does NOT tolerate thousands separators or multiple dots. Plain JS
    // number-to-string interpolation (as below) is locale-invariant (always uses "." and never
    // inserts group separators, unlike Number.prototype.toLocaleString()), so this is always safe
    // to send as-is - just never swap this for `seconds.toLocaleString()`.
    this.send(`set-position: ${seconds}`);
  }

  setSpeed(_rate: number): void {
    // Deliberately unsupported - see `speedSupported` above.
  }

  displayMessage(text: string, options?: DisplayMessageOptions): void {
    const duration = options?.duration ?? 3;
    const safeText = text.replace(/[\r\n]+/g, " ");
    const isAlert = options?.osdOnly || options?.osdType === "alert";
    if (isAlert) {
      this.send(`display-secondary-osd: center, ${duration}, ${safeText}`);
    } else {
      this.send(`display-osd: top-right, ${duration}, ${safeText}`);
    }
  }

  quit(): void {
    this.manualQuit = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.send("close-vlc");
    this.socket?.destroy();
    this.process?.kill();
  }
}
