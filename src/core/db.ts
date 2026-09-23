import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS } from "./migrations";

export type DB = Database.Database;

export function dataDir(): string {
  return path.resolve(process.env.DATA_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), "data"));
}
export function dbPath(): string {
  return process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(dataDir(), "outlier.db");
}
export function assetsDir(): string {
  return path.join(dataDir(), "assets");
}

const g = globalThis as unknown as { __omosDb?: DB; __omosDbPath?: string };

/** Open (once per process) and migrate the operational database. */
export function getDb(): DB {
  const p = dbPath();
  if (g.__omosDb && g.__omosDbPath === p) return g.__omosDb;
  if (g.__omosDb) g.__omosDb.close();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.mkdirSync(assetsDir(), { recursive: true });
  const db = new Database(p);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  migrate(db);
  g.__omosDb = db;
  g.__omosDbPath = p;
  return db;
}

/** For tests: open an isolated database at a given path. */
export function openDbAt(file: string): DB {
  process.env.DB_PATH = file;
  process.env.DATA_DIR = path.dirname(file);
  if (g.__omosDb) {
    g.__omosDb.close();
    g.__omosDb = undefined;
  }
  return getDb();
}

export function closeDb() {
  if (g.__omosDb) {
    g.__omosDb.close();
    g.__omosDb = undefined;
    g.__omosDbPath = undefined;
  }
}

export function migrate(db: DB): { applied: number[] } {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const done = new Set<number>(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version),
  );
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)").run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    })();
    applied.push(m.version);
  }
  return { applied };
}

export function currentSchemaVersion(db: DB = getDb()): number {
  const r = db.prepare("SELECT MAX(version) v FROM schema_migrations").get() as { v: number | null };
  return r.v ?? 0;
}

export function tx<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}
