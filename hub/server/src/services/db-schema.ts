import type { DatabaseSync } from 'node:sqlite';

/**
 * Normalized Local_DB schema (redesign).
 *
 * Replaces the previous "one JSON blob per row" layout. Every core dataset now
 * has a real table with one column per scalar field; one-to-many relations
 * (webhook events, env-profile entries, dashboard widgets) live in dedicated
 * child tables. Genuinely nested / secondary datasets (matrix-runs, k6-trends,
 * flaky-tests, cleanup-history) stay as a typed JSON document in `kv_store`
 * (Option B — normalize later).
 *
 * The embedded `RunRequest` shared by history / schedules / bookmarks is
 * flattened into `req_*` columns by `db-run-request.ts`.
 */

/** SQLite-storable scalar (matches node:sqlite SQLInputValue/SQLOutputValue). */
export type SqlValue = null | number | bigint | string | Uint8Array;
/** A row as returned by `Statement.get()/all()`. */
export type Row = Record<string, SqlValue>;

/** Current schema version. Bumped when the table layout changes. */
export const SCHEMA_VERSION = 2;
/** `meta` key holding the integer schema version. */
export const SCHEMA_VERSION_KEY = 'schema_version';

/**
 * Flattened `RunRequest` column definitions, shared by `history`, `schedules`
 * and `bookmarks`. Booleans are stored as INTEGER (0/1, NULL when absent).
 */
export const RUN_REQUEST_DDL = `
  req_tool             TEXT,
  req_type             TEXT,
  req_project          TEXT,
  req_mode             TEXT,
  req_tag              TEXT,
  req_headless         TEXT,
  req_extra_args       TEXT,
  req_no_track         INTEGER,
  req_silent           INTEGER,
  req_discard_report   INTEGER,
  req_section          TEXT,
  req_performance_type TEXT
`;

/**
 * Full normalized schema. Every statement is `IF NOT EXISTS`, so running it on
 * an already-prepared database is a no-op. Run AFTER {@link upgradeSchema} has
 * dropped any legacy blob-shaped tables.
 */
export const SCHEMA_DDL = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS meta     (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS kv_store (name TEXT PRIMARY KEY, data TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS history (
    id          TEXT PRIMARY KEY,
    status      TEXT NOT NULL,
    command     TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    ended_at    TEXT,
    exit_code   INTEGER,
    report_path TEXT,
    output_stamp    TEXT,
    summary_passed  INTEGER,
    summary_failed  INTEGER,
    summary_skipped INTEGER,
    triggered_by    TEXT,
    ${RUN_REQUEST_DDL}
  );
  CREATE INDEX IF NOT EXISTS idx_history_started_at ON history(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_history_project    ON history(req_project);
  CREATE INDEX IF NOT EXISTS idx_history_status     ON history(status);

  CREATE TABLE IF NOT EXISTS schedules (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    cron         TEXT NOT NULL,
    enabled      INTEGER NOT NULL,
    created_at   TEXT NOT NULL,
    last_run_at  TEXT,
    last_status  TEXT,
    last_run_id  TEXT,
    next_run_at  TEXT,
    no_overlap   INTEGER,
    ${RUN_REQUEST_DDL}
  );

  CREATE TABLE IF NOT EXISTS bookmarks (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    ${RUN_REQUEST_DDL}
  );

  CREATE TABLE IF NOT EXISTS webhooks (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    platform         TEXT NOT NULL,
    url              TEXT NOT NULL,
    token            TEXT,
    recipient_id     TEXT,
    enabled          INTEGER NOT NULL,
    created_at       TEXT NOT NULL,
    last_triggered_at TEXT,
    last_status      TEXT,
    scope_tool       TEXT,
    scope_type       TEXT,
    scope_project    TEXT,
    project_filter   TEXT
  );
  CREATE TABLE IF NOT EXISTS webhook_events (
    webhook_id TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    event      TEXT NOT NULL,
    PRIMARY KEY (webhook_id, seq),
    FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS env_profiles (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    environment TEXT NOT NULL,
    tool        TEXT NOT NULL,
    type        TEXT NOT NULL,
    project     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS env_profile_entries (
    profile_id TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    PRIMARY KEY (profile_id, key),
    FOREIGN KEY (profile_id) REFERENCES env_profiles(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS annotations (
    id         TEXT PRIMARY KEY,
    report_id  TEXT NOT NULL,
    author     TEXT NOT NULL,
    content    TEXT NOT NULL,
    type       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS retention (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    retention_days INTEGER NOT NULL,
    auto_cleanup  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS dashboard_meta    (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS dashboard_widgets (
    seq       INTEGER PRIMARY KEY,
    widget_id TEXT NOT NULL,
    label     TEXT NOT NULL,
    visible   INTEGER NOT NULL,
    sort_order INTEGER NOT NULL,
    span      INTEGER NOT NULL
  );
`;

/** True when `table` exists in the database. */
export function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as Row | undefined;
  return row !== undefined;
}

/** True when `table` exists and has a column named `column`. */
export function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
  return cols.some((c) => c.name === column);
}

// --- scalar <-> column coercion helpers -------------------------------------

/** Column value for an optional string (NULL when undefined). */
export function strCol(v: string | undefined): SqlValue {
  return v ?? null;
}

/** Column value for an optional number (NULL when undefined; 0 preserved). */
export function numCol(v: number | undefined): SqlValue {
  return v === undefined ? null : v;
}

/** Column value for an optional boolean (NULL when undefined; false preserved as 0). */
export function boolCol(v: boolean | undefined): SqlValue {
  return v === undefined ? null : v ? 1 : 0;
}

/** Read an optional string column (NULL -> undefined). */
export function readStr(v: SqlValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Read a required string column (NULL/non-string -> ''). */
export function readReqStr(v: SqlValue | undefined): string {
  return typeof v === 'string' ? v : '';
}

/** Read an optional number column (NULL -> undefined; 0 preserved). */
export function readNum(v: SqlValue | undefined): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return undefined;
}

/** Read an optional boolean column (NULL -> undefined; 0 -> false). */
export function readBool(v: SqlValue | undefined): boolean | undefined {
  if (v === null || v === undefined) return undefined;
  return Number(v) !== 0;
}
