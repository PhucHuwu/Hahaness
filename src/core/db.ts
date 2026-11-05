import { createRequire } from "node:module"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite"

/**
 * `node:sqlite` in Node 22 prints an ExperimentalWarning on load. Filter only that
 * single warning, during the one require, so we don't swallow others.
 */
function loadSqlite(): typeof import("node:sqlite") {
  const original = process.emitWarning
  process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
    const msg = typeof warning === "string" ? warning : warning?.message
    if (String(msg).includes("SQLite")) return
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest)
  } as typeof process.emitWarning
  try {
    return createRequire(import.meta.url)("node:sqlite")
  } finally {
    process.emitWarning = original
  }
}

const { DatabaseSync } = loadSqlite()

const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, seq);
CREATE TABLE IF NOT EXISTS documents (
  path TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  author TEXT
);
CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  markdown TEXT NOT NULL,
  fired INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  config TEXT NOT NULL
);
`

/** Một file SQLite chứa toàn bộ công ty. `:memory:` cho test. */
export class Db {
  readonly sql: DatabaseSyncType
  /** true nếu file vừa được tạo (dùng để import workspace kiểu cũ một lần). */
  readonly fresh: boolean

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.sql = new DatabaseSync(path)
    this.sql.exec("PRAGMA busy_timeout = 5000")
    const version = Number((this.sql.prepare("PRAGMA user_version").get() as { user_version: number }).user_version)
    this.fresh = version === 0
    if (version < SCHEMA_VERSION) {
      this.sql.exec(SCHEMA)
      this.sql.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    }
  }

  tx<T>(fn: () => T): T {
    this.sql.exec("BEGIN")
    try {
      const out = fn()
      this.sql.exec("COMMIT")
      return out
    } catch (e) {
      this.sql.exec("ROLLBACK")
      throw e
    }
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.sql.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as T) : undefined
  }

  setSetting(key: string, value: unknown) {
    this.sql.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value))
  }

  private closed = false
  close() {
    if (this.closed) return
    this.closed = true
    this.sql.close()
  }
}
