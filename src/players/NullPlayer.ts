// A mock player with no external process - simulates position advancing on its own clock.
// Used for headless testing/demoing the sync engine and TUI without mpv/VLC installed.

import { EventEmitter } from "node:events";
import type { DisplayMessageOptions, Player, PlayerFileInfo } from "./BasePlayer.js";

export class NullPlayer extends EventEmitter implements Player {
  readonly name = "null";
  readonly speedSupported = true;

  private position = 0;
  private paused = true;
  private speed = 1.0;
  private lastTick = Date.now();
  private ticker: NodeJS.Timeout;
  private file: PlayerFileInfo | null = null;

  constructor() {
    super();
    this.ticker = setInterval(() => this.tick(), 250);
  }

  private tick(): void {
    const now = Date.now();
    if (!this.paused) {
      this.position += ((now - this.lastTick) / 1000) * this.speed;
    }
    this.lastTick = now;
    this.emit("status", { paused: this.paused, position: this.position });
  }

  async open(filePath: string): Promise<void> {
    if (!filePath) return;
    this.file = { name: filePath.split(/[/\\]/).pop() ?? filePath, path: filePath, duration: 0 };
    this.position = 0;
    this.paused = true;
    this.lastTick = Date.now();
    this.emit("fileInfo", this.file);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.lastTick = Date.now();
    this.emit("status", { paused: this.paused, position: this.position });
  }

  setPosition(seconds: number): void {
    this.position = seconds;
    this.lastTick = Date.now();
    this.emit("status", { paused: this.paused, position: this.position });
  }

  setSpeed(rate: number): void {
    this.speed = rate;
  }

  displayMessage(text: string, options?: DisplayMessageOptions): void {
    const alert = options?.osdOnly || options?.osdType === "alert";
    console.log(`[NullPlayer OSD${alert ? " alert" : ""}] ${text}`);
  }

  quit(): void {
    clearInterval(this.ticker);
    this.emit("close");
  }
}
