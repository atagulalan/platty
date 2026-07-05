// Persistence backends for --rooms-db-file / --stats-db-file / --permanent-rooms-file.
// See ../../../spec/server/playlist-and-persistence.md and
// ../../../spec/server/overview-and-cli.md#stats-db and #full-cli-reference.
//
// Behavioral parity only - this is deliberately NOT byte-identical with the reference server's
// own SQLite schema (there is no requirement to read/write the same .db files as the Python
// implementation, only to reproduce the same user-visible behavior):
//   - the playlist column is stored JSON-encoded, not newline-joined - the reference format's
//     newline-join is called out in the spec as corrupting any filename containing a literal
//     newline; JSON sidesteps that entirely.
//   - if `node:sqlite`'s `DatabaseSync` throws or is unavailable in the running Node build (it's
//     a fairly recent, still-experimental addition), we transparently fall back to a hand-rolled
//     JSON-file store at the same configured path. The two backends use different on-disk
//     formats, so switching Node versions across restarts (sqlite <-> JSON fallback) will not
//     carry old data forward - this is an accepted limitation for this simple rewrite.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

export interface RoomRecord {
  name: string;
  playlist: string[];
  playlistIndex: number | null;
  position: number;
  lastSavedUpdate: number;
}

type SqliteModule = typeof import("node:sqlite");

function tryLoadSqlite(): SqliteModule | null {
  try {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("node:sqlite") as SqliteModule;
  } catch {
    return null;
  }
}

const sqliteModule = tryLoadSqlite();

export interface RoomsStore {
  loadAll(): RoomRecord[];
  save(record: RoomRecord): void;
  delete(name: string): void;
  close(): void;
}

class SqliteRoomsStore implements RoomsStore {
  private readonly db: InstanceType<SqliteModule["DatabaseSync"]>;

  constructor(path: string) {
    const { DatabaseSync } = sqliteModule!;
    this.db = new DatabaseSync(path);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS persistent_rooms (
        name TEXT PRIMARY KEY,
        playlist TEXT,
        playlistIndex INTEGER,
        position REAL,
        lastSavedUpdate INTEGER
      )`,
    );
  }

  loadAll(): RoomRecord[] {
    const rows = this.db
      .prepare("SELECT name, playlist, playlistIndex, position, lastSavedUpdate FROM persistent_rooms")
      .all() as Array<{
      name: string;
      playlist: string | null;
      playlistIndex: number | null;
      position: number | null;
      lastSavedUpdate: number | null;
    }>;
    return rows.map((r) => ({
      name: r.name,
      playlist: r.playlist ? (JSON.parse(r.playlist) as string[]) : [],
      playlistIndex: r.playlistIndex,
      position: r.position ?? 0,
      lastSavedUpdate: r.lastSavedUpdate ?? 0,
    }));
  }

  save(record: RoomRecord): void {
    this.db
      .prepare(
        `INSERT INTO persistent_rooms (name, playlist, playlistIndex, position, lastSavedUpdate)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           playlist = excluded.playlist,
           playlistIndex = excluded.playlistIndex,
           position = excluded.position,
           lastSavedUpdate = excluded.lastSavedUpdate`,
      )
      .run(record.name, JSON.stringify(record.playlist), record.playlistIndex, record.position, record.lastSavedUpdate);
  }

  delete(name: string): void {
    this.db.prepare("DELETE FROM persistent_rooms WHERE name = ?").run(name);
  }

  close(): void {
    this.db.close();
  }
}

class JsonRoomsStore implements RoomsStore {
  private data: Record<string, RoomRecord> = {};

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      try {
        this.data = JSON.parse(readFileSync(path, "utf8")) as Record<string, RoomRecord>;
      } catch {
        this.data = {};
      }
    }
  }

  private flush(): void {
    writeFileSync(this.path, JSON.stringify(this.data), "utf8");
  }

  loadAll(): RoomRecord[] {
    return Object.values(this.data);
  }

  save(record: RoomRecord): void {
    this.data[record.name] = record;
    this.flush();
  }

  delete(name: string): void {
    delete this.data[name];
    this.flush();
  }

  close(): void {
    /* no persistent connection to close */
  }
}

export function openRoomsStore(path: string): RoomsStore {
  if (sqliteModule) {
    try {
      return new SqliteRoomsStore(path);
    } catch {
      // fall through to the JSON backend below
    }
  }
  return new JsonRoomsStore(path);
}

export interface StatsStore {
  /** Records one snapshot: current connection count + a version -> count histogram. */
  recordSnapshot(versions: string[]): void;
  close(): void;
}

class SqliteStatsStore implements StatsStore {
  private readonly db: InstanceType<SqliteModule["DatabaseSync"]>;

  constructor(path: string) {
    const { DatabaseSync } = sqliteModule!;
    this.db = new DatabaseSync(path);
    // Same shape as the reference server's `clients_snapshots` table (one row per connected
    // client per snapshot tick) - querying COUNT(*)/GROUP BY version over a given snapshot_time
    // recovers both the connection count and the version histogram.
    this.db.exec("CREATE TABLE IF NOT EXISTS clients_snapshots (snapshot_time INTEGER, version STRING)");
  }

  recordSnapshot(versions: string[]): void {
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare("INSERT INTO clients_snapshots VALUES (?, ?)");
    for (const version of versions) stmt.run(now, version);
  }

  close(): void {
    this.db.close();
  }
}

interface StatsSnapshotRow {
  snapshotTime: number;
  connectionCount: number;
  versions: Record<string, number>;
}

class JsonStatsStore implements StatsStore {
  private snapshots: StatsSnapshotRow[] = [];

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      try {
        this.snapshots = JSON.parse(readFileSync(path, "utf8")) as StatsSnapshotRow[];
      } catch {
        this.snapshots = [];
      }
    }
  }

  recordSnapshot(versions: string[]): void {
    const histogram: Record<string, number> = {};
    for (const version of versions) histogram[version] = (histogram[version] ?? 0) + 1;
    this.snapshots.push({ snapshotTime: Math.floor(Date.now() / 1000), connectionCount: versions.length, versions: histogram });
    writeFileSync(this.path, JSON.stringify(this.snapshots), "utf8");
  }

  close(): void {
    /* no persistent connection to close */
  }
}

export function openStatsStore(path: string): StatsStore {
  if (sqliteModule) {
    try {
      return new SqliteStatsStore(path);
    } catch {
      // fall through to the JSON backend below
    }
  }
  return new JsonStatsStore(path);
}

/**
 * --permanent-rooms-file format: one room name per line (blank lines ignored, no other syntax) -
 * matches the reference server's `loadListFromMultilineTextFile` (`server.py:66-70`). A missing
 * file yields an empty set (also matching the reference: "ignored if missing").
 */
export function loadPermanentRoomNames(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const content = readFileSync(path, "utf8");
  return new Set(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}
