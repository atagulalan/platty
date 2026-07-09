// mpv integration via mpv's real JSON IPC socket + bundled syncplayintf.lua overlay.
// See ../../spec/players/mpv-family.md.

import { EventEmitter } from "node:events";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { platform } from "node:process";
import type { DisplayMessageOptions, Player, PlayerFileInfo } from "./BasePlayer.js";
import {
  buildSyncplayIntfOptionsString,
  osdScriptMessage,
  MPV_INPUT_BACKSLASH_SUBSTITUTE_CHARACTER,
  restoreMpvChatBackslashes,
  sanitizeMpvOsdText,
  syncplayIntfScriptPath,
  type OsdMood,
  type OsdType,
  type SyncplayIntfConfig,
} from "./mpvSyncplayIntf.js";

const MPV_MIN_VERSION_STRING = "0.23.0";
const MPV_MIN_MAJOR = 0;
const MPV_MIN_MINOR = 23;
const MPV_OSC_VISIBILITY_MINOR = 28;
const MPV_VERSION_RE = /mpv\s+v?(\d+)\.(\d+)/i;

export interface MpvPlayerOptions {
  extraArgs?: string[];
  skipVersionCheck?: boolean;
  /** Memento uses `--scripts=` (plural) instead of `--script=` — see spec/players/mpv-family.md. */
  scriptArgName?: "script" | "scripts";
  syncplayIntf?: SyncplayIntfConfig;
}

interface MpvRequest {
  command: unknown[];
  request_id: number;
}
interface MpvResponse {
  request_id?: number;
  error?: string;
  data?: unknown;
  event?: string;
  id?: number;
  name?: string;
  prefix?: string;
  text?: string;
}

const PROP_PAUSE = 1;
const PROP_TIME_POS = 2;
const PROP_DURATION = 3;
const PROP_PATH = 4;

export class MpvPlayer extends EventEmitter implements Player {
  readonly name = "mpv";
  readonly speedSupported = true;
  readonly alertOsdSupported = true;
  readonly osdMessageSeparator = "; ";

  private process: ChildProcessWithoutNullStreams | null = null;
  private socket: Socket | null = null;
  private buffer = "";
  private requestSeq = 1;
  private readonly pending = new Map<number, (res: MpvResponse) => void>();

  private lastPaused = true;
  private lastPosition = 0;
  private lastDuration = 0;
  private lastPath = "";
  private fileAnnounced = false;
  private oscVisibilityChangeCompatible = false;

  constructor(
    private readonly mpvPath = "mpv",
    private readonly options: MpvPlayerOptions = {},
  ) {
    super();
  }

  private socketPath(pid: number): string {
    return platform === "win32"
      ? `\\\\.\\pipe\\syncplay-ts-mpv-${pid}`
      : `${tmpdir()}/syncplay-ts-mpv-${pid}.sock`;
  }

  private formatSpawnError(err: NodeJS.ErrnoException): Error {
    if (err.code === "ENOENT") {
      return new Error(
        `Could not find mpv at "${this.mpvPath}". Install mpv and add it to your PATH, or set playerPath in ~/.config/splatty/splatty.ini.`,
      );
    }
    return err;
  }

  private waitForSpawn(proc: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise((resolve, reject) => {
      proc.once("spawn", () => resolve());
      proc.once("error", (err) => reject(this.formatSpawnError(err)));
    });
  }

  private checkMinimumVersion(): Promise<{ oscVisibilityChangeCompatible: boolean }> {
    return new Promise((resolve, reject) => {
      execFile(this.mpvPath, ["--version"], (err, stdout) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(this.formatSpawnError(err as NodeJS.ErrnoException));
            return;
          }
          resolve({ oscVisibilityChangeCompatible: false });
          return;
        }
        if (!stdout) {
          resolve({ oscVisibilityChangeCompatible: false });
          return;
        }
        const match = MPV_VERSION_RE.exec(stdout);
        if (!match) {
          resolve({ oscVisibilityChangeCompatible: false });
          return;
        }
        const major = Number(match[1]);
        const minor = Number(match[2]);
        const newEnough = major > MPV_MIN_MAJOR || minor >= MPV_MIN_MINOR;
        if (!newEnough) {
          reject(
            new Error(
              `mpv version ${major}.${minor} is too old for Syncplay - requires mpv >= ${MPV_MIN_VERSION_STRING}. Please upgrade mpv.`,
            ),
          );
          return;
        }
        resolve({
          oscVisibilityChangeCompatible: major > 0 || minor >= MPV_OSC_VISIBILITY_MINOR,
        });
      });
    });
  }

  async open(filePath: string): Promise<void> {
    if (this.process) {
      if (filePath) await this.request(["loadfile", filePath, "replace"]);
      return;
    }

    const versionCheck = this.options.skipVersionCheck
      ? Promise.resolve({ oscVisibilityChangeCompatible: true })
      : this.checkMinimumVersion();

    const scriptPath = syncplayIntfScriptPath();
    const scriptFlag = `--${this.options.scriptArgName ?? "script"}=${scriptPath}`;
    const ipcPath = this.socketPath(process.pid);

    const proc = spawn(
      this.mpvPath,
      [
        "--idle=yes",
        "--force-window=yes",
        "--keep-open=yes",
        "--hr-seek=always",
        "--keep-open-pause=yes",
        "--input-terminal=no",
        `--input-ipc-server=${ipcPath}`,
        scriptFlag,
        ...(this.options.extraArgs ?? []),
      ],
      {
        env: (() => {
          const env = { ...process.env };
          delete env.TERM;
          return env;
        })(),
      },
    );
    this.process = proc;
    proc.on("exit", () => {
      this.emit("close");
    });
    proc.on("error", (err) => this.emit("error", err));

    try {
      const [versionInfo] = await Promise.all([versionCheck, this.waitForSpawn(proc)]);
      this.oscVisibilityChangeCompatible = versionInfo.oscVisibilityChangeCompatible;
    } catch (err) {
      proc.kill();
      this.process = null;
      throw err;
    }

    await this.connectWithRetry(ipcPath);
    await this.request(["observe_property", PROP_PAUSE, "pause"]);
    await this.request(["observe_property", PROP_TIME_POS, "time-pos"]);
    await this.request(["observe_property", PROP_DURATION, "duration"]);
    await this.request(["observe_property", PROP_PATH, "path"]);
    await this.request(["enable_event", "log-message", { min_level: "info" }]);

    await this.applySyncplayIntfOptions();
    if (filePath) await this.request(["loadfile", filePath, "replace"]);
  }

  private connectWithRetry(path: string, attemptsLeft = 50): Promise<void> {
    return new Promise((resolve, reject) => {
      const attempt = (): void => {
        const socket = connect({ path });
        socket.once("connect", () => {
          this.socket = socket;
          socket.setEncoding("utf8");
          socket.on("data", (chunk: string) => this.onData(chunk));
          socket.on("close", () => this.emit("close"));
          resolve();
        });
        socket.once("error", () => {
          socket.destroy();
          if (attemptsLeft <= 0) {
            reject(new Error(`Could not connect to mpv IPC socket at ${path}`));
            return;
          }
          setTimeout(
            () => this.connectWithRetry(path, attemptsLeft - 1).then(resolve, reject),
            100,
          );
        });
      };
      attempt();
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: MpvResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.handleMpvMessage(msg);
    }
  }

  private handleMpvMessage(msg: MpvResponse): void {
    if (msg.request_id !== undefined) {
      this.pending.get(msg.request_id)?.(msg);
      this.pending.delete(msg.request_id);
      return;
    }
    if (msg.event === "property-change") {
      this.handlePropertyChange(msg);
      return;
    }
    if (msg.event === "log-message" && msg.text) {
      this.handleLogLine(msg.text);
    }
  }

  private handleLogLine(line: string): void {
    if (line.includes("<get_syncplayintf_options>")) {
      void this.applySyncplayIntfOptions();
      return;
    }
    const chatMatch = /<chat>(.*)<\/chat>/.exec(line);
    if (chatMatch) {
      const message = restoreMpvChatBackslashes(chatMatch[1] ?? "");
      if (message) this.emit("chatInput", message);
      return;
    }
    if (line.includes("<eof>")) {
      this.emit("eof");
    }
  }

  private handlePropertyChange(msg: MpvResponse): void {
    switch (msg.id) {
      case PROP_PAUSE:
        this.lastPaused = !!msg.data;
        this.emitStatus();
        break;
      case PROP_TIME_POS:
        if (typeof msg.data === "number") {
          this.lastPosition = msg.data;
          this.emitStatus();
        }
        break;
      case PROP_DURATION:
        if (typeof msg.data === "number") {
          this.lastDuration = msg.data;
          this.maybeAnnounceFile();
        }
        break;
      case PROP_PATH:
        if (typeof msg.data === "string") {
          this.lastPath = msg.data;
          this.fileAnnounced = false;
          this.maybeAnnounceFile();
        }
        break;
    }
  }

  private maybeAnnounceFile(): void {
    if (this.fileAnnounced || !this.lastPath || !this.lastDuration) return;
    this.fileAnnounced = true;
    const info: PlayerFileInfo = {
      name: this.lastPath.split(/[/\\]/).pop() ?? this.lastPath,
      path: this.lastPath,
      duration: this.lastDuration,
    };
    this.emit("fileInfo", info);
  }

  private emitStatus(): void {
    this.emit("status", { paused: this.lastPaused, position: this.lastPosition });
  }

  private request(command: unknown[]): Promise<MpvResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error("mpv IPC socket not connected"));
        return;
      }
      const request_id = this.requestSeq++;
      const req: MpvRequest = { command, request_id };
      this.pending.set(request_id, resolve);
      this.socket.write(JSON.stringify(req) + "\n", "utf8");
    });
  }

  private scriptMessage(messageName: string, text: string): void {
    const messageString = sanitizeMpvOsdText(text.replace(/\\n/g, "<NEWLINE>"))
      .replace(/\\\\/g, MPV_INPUT_BACKSLASH_SUBSTITUTE_CHARACTER)
      .replace(/<NEWLINE>/g, "\\n");
    void this.request(["script-message-to", "syncplayintf", messageName, messageString]).catch(
      () => {},
    );
  }

  async applySyncplayIntfOptions(): Promise<void> {
    const cfg = this.options.syncplayIntf;
    if (!cfg) return;
    const optionsString = buildSyncplayIntfOptionsString({
      ...cfg,
      oscVisibilityChangeCompatible: this.oscVisibilityChangeCompatible,
    });
    await this.request([
      "script-message-to",
      "syncplayintf",
      "set_syncplayintf_options",
      optionsString,
    ]).catch(() => {});
    this.applyOsdPosition(cfg);
  }

  private applyOsdPosition(cfg: SyncplayIntfConfig): void {
    const moveOsd =
      cfg.chatMoveOSD &&
      (cfg.chatOutputEnabled || (cfg.chatInputEnabled && cfg.chatInputPosition === "Top"));
    if (!moveOsd) return;
    void this.request(["set_property", "osd-align-y", "bottom"]).catch(() => {});
    void this.request(["set_property", "osd-margin-y", cfg.chatOSDMargin]).catch(() => {});
  }

  setPaused(paused: boolean): void {
    void this.request(["set_property", "pause", paused]).catch(() => {});
  }

  setPosition(seconds: number): void {
    void this.request(["set_property", "time-pos", seconds]).catch(() => {});
  }

  setSpeed(rate: number): void {
    void this.request(["set_property", "speed", rate]).catch(() => {});
  }

  displayMessage(text: string, options: DisplayMessageOptions = {}): void {
    const cfg = this.options.syncplayIntf;
    const osdType: OsdType = options.osdType ?? (options.osdOnly ? "alert" : "notification");
    const mood: OsdMood = options.mood ?? "neutral";

    if (!cfg?.chatOutputEnabled) {
      const durationMs = Math.round((options.duration ?? 3) * 1000);
      const sanitized = sanitizeMpvOsdText(text.replace(/\\n/g, "<NEWLINE>")).replace(
        /<NEWLINE>/g,
        "\\n",
      );
      void this.request(["show-text", sanitized, durationMs, 1]).catch(() => {});
      return;
    }

    this.scriptMessage(osdScriptMessage(osdType, mood), text);
  }

  displayChatMessage(username: string, message: string): void {
    const cfg = this.options.syncplayIntf;
    const safeUser = sanitizeMpvOsdText(
      username.replace(/\\/g, MPV_INPUT_BACKSLASH_SUBSTITUTE_CHARACTER),
    );
    const safeMessage = sanitizeMpvOsdText(
      message.replace(/\\/g, MPV_INPUT_BACKSLASH_SUBSTITUTE_CHARACTER),
    );
    const line = `<${safeUser}> ${safeMessage}`;

    if (!cfg?.chatOutputEnabled) {
      void this.request(["show-text", line, 3000, 1]).catch(() => {});
      return;
    }

    this.scriptMessage("chat", line);
  }

  quit(): void {
    if (this.socket) {
      this.socket.write(JSON.stringify({ command: ["quit"], request_id: 0 }) + "\n", "utf8");
      this.socket.destroy();
      this.socket = null;
    }
    this.process?.kill();
    this.process = null;
  }
}
