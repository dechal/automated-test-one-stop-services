import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RunRecord } from '@hub/shared';
import {
  annotationsRepo,
  bookmarksRepo,
  type CollectionRepo,
  type DocRepo,
  dashboardRepo,
  envProfilesRepo,
  historyRepo,
  retentionRepo,
  schedulesRepo,
  webhooksRepo,
} from './db-repositories.js';
import {
  hasColumn,
  type Row,
  SCHEMA_DDL,
  SCHEMA_VERSION,
  SCHEMA_VERSION_KEY,
  tableExists,
} from './db-schema.js';

/**
 * Local_DB — node:sqlite backing store with a NORMALIZED schema.
 *
 * Each core dataset is a real table with one column per scalar field; the
 * embedded `RunRequest` is flattened into `req_*` columns and one-to-many
 * relations live in child tables (see `db-schema.ts` / `db-repositories.ts`).
 * Secondary/deeply-nested datasets (matrix-runs, k6-trends, flaky-tests,
 * cleanup-history) remain a typed JSON document in `kv_store` (Option B).
 *
 * The PUBLIC `LocalDb` interface is unchanged, so `persistence.ts` and
 * `history-store.ts` (and therefore every service/route) keep working with no
 * contract change — the row<->object mapping happens inside the repositories.
 *
 * Semantics preserved from the previous layer:
 *   - boot-time synchronous load: `DatabaseSync` is synchronous;
 *     `openLocalDb` prepares the whole schema (and runs any legacy upgrade)
 *     before returning.
 *   - isolation: every read builds fresh objects from columns, so the
 *     returned value never aliases internal state.
 *   - atomic + serialized writes: `writeCollection` /
 *     `appendHistory` wrap `BEGIN IMMEDIATE … COMMIT`, `ROLLBACK` + rethrow on
 *     failure; `DatabaseSync` runs synchronously so writes never interleave.
 *   - MAX_HISTORY = 200: `appendHistory` inserts then trims.
 */

/** Maximum number of history records retained. */
export const MAX_HISTORY = 200;

/** Dataset stored in the dedicated `history` table. */
const HISTORY_COLLECTION = 'history';

/** Array-collection datasets backed by a normalized table. */
const COLLECTION_REPOS: Readonly<Record<string, CollectionRepo<unknown>>> = {
  'schedules.json': schedulesRepo as CollectionRepo<unknown>,
  'bookmarks.json': bookmarksRepo as CollectionRepo<unknown>,
  'webhooks.json': webhooksRepo as CollectionRepo<unknown>,
  'env-profiles.json': envProfilesRepo as CollectionRepo<unknown>,
  'annotations.json': annotationsRepo as CollectionRepo<unknown>,
};

/** Single-document datasets backed by a normalized table. */
const DOC_REPOS: Readonly<Record<string, DocRepo<unknown>>> = {
  'retention.json': retentionRepo as DocRepo<unknown>,
  'dashboard-layout.json': dashboardRepo as DocRepo<unknown>,
};

/**
 * Legacy blob-shaped tables (old "one JSON blob per row" layout) to detect and
 * upgrade on open. `marker` is a column that only exists in the NEW normalized
 * shape; its absence (with a `data` column present) flags an old table.
 */
const LEGACY_BLOB_TABLES: ReadonlyArray<{ dataset: string; table: string; marker: string }> = [
  { dataset: HISTORY_COLLECTION, table: 'history', marker: 'req_tool' },
  { dataset: 'schedules.json', table: 'schedules', marker: 'name' },
  { dataset: 'bookmarks.json', table: 'bookmarks', marker: 'name' },
  { dataset: 'webhooks.json', table: 'webhooks', marker: 'platform' },
  { dataset: 'env-profiles.json', table: 'env_profiles', marker: 'name' },
  { dataset: 'annotations.json', table: 'annotations', marker: 'report_id' },
  // matrix_runs was a per-feature blob table; it now lives in kv_store.
  { dataset: 'matrix-runs.json', table: 'matrix_runs', marker: '__never__' },
];

export interface LocalDb {
  /** Read a dataset as an array. Returns `[]` when absent. */
  readCollection<T>(name: string): T[];
  /** Read a single-document dataset (or full array for collections). */
  readDoc<T>(name: string): T | undefined;
  /** Replace a whole collection / write a document inside one transaction. */
  writeCollection<T>(name: string, rows: T[]): void;
  /** Append one history record then trim to MAX_HISTORY. */
  appendHistory(rec: RunRecord): void;
  /** Read a meta marker (used by DB migration). */
  getMeta(key: string): string | undefined;
  /** Write a meta marker (used by DB migration). */
  setMeta(key: string, value: string): void;
}

/** SQLite TEXT column as a string, else undefined. */
function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Open (or create) the Local_DB at `dbPath`, upgrade any legacy blob tables,
 * prepare the normalized schema, and return synchronously. Pass
 * `':memory:'` for an ephemeral DB (tests). Parent dir is created for
 * file-backed databases.
 */
export function openLocalDb(dbPath: string): LocalDb {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(path.resolve(dbPath));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);

  // `meta` must exist before we can read the schema version.
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');

  function getMeta(key: string): string | undefined {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined;
    return row ? asText(row.value) : undefined;
  }

  function transact(fn: () => void): void {
    db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // A rollback failure must not mask the original error.
      }
      throw err;
    }
  }

  // --- legacy upgrade (only when the schema is not already current) ---------
  const currentVersion = Number(getMeta(SCHEMA_VERSION_KEY) ?? '0');
  let legacyStash: Record<string, unknown[]> = {};
  if (currentVersion < SCHEMA_VERSION) {
    legacyStash = drainLegacyBlobTables(db);
  }

  // Prepare the normalized schema (idempotent).
  db.exec(SCHEMA_DDL);

  // Additive migration: `CREATE TABLE IF NOT EXISTS` never alters an existing
  // table, so add the summary columns to history DBs created before they
  // existed. Guarded by `hasColumn`, so this is a no-op on current DBs.
  ensureHistorySummaryColumns(db);

  // --- repo dispatch helpers -------------------------------------------------
  function writeDataset(name: string, rows: unknown[] | unknown): void {
    if (name === HISTORY_COLLECTION) {
      historyRepo.replaceAll(db, rows as RunRecord[]);
      return;
    }
    const col = COLLECTION_REPOS[name];
    if (col) {
      col.replaceAll(db, rows as unknown[]);
      return;
    }
    const doc = DOC_REPOS[name];
    if (doc) {
      // An array payload is a "clear" request (migration); an object is a write.
      if (Array.isArray(rows)) doc.clear(db);
      else doc.write(db, rows);
      return;
    }
    // kv_store JSON fallback (matrix-runs, k6-trends, flaky-tests, cleanup, …).
    const data = JSON.stringify(rows);
    db.prepare(
      'INSERT INTO kv_store (name, data) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data',
    ).run(name, data);
  }

  function readKv(name: string): unknown {
    const row = db.prepare('SELECT data FROM kv_store WHERE name = ?').get(name) as Row | undefined;
    if (!row) return undefined;
    const text = asText(row.data);
    if (text === undefined) return undefined;
    // A single corrupt kv_store row must not throw and take down every read of
    // its dataset (matrix-runs / k6-trends / flaky / cleanup) — treat unparseable
    // data as absent.
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  // Re-insert anything rescued from a legacy upgrade, now that the schema and
  // dispatch helpers exist.
  if (Object.keys(legacyStash).length > 0) {
    transact(() => {
      for (const [name, items] of Object.entries(legacyStash)) writeDataset(name, items);
    });
  }

  // Migrate any legacy `kv_store` rows that now belong in a normalized table
  // (older DBs kept retention/dashboard and sometimes whole collections here).
  migrateLegacyKvRows(db, transact, writeDataset);

  // Record the current schema version so the upgrade path is skipped next time.
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(SCHEMA_VERSION_KEY, String(SCHEMA_VERSION));

  return {
    readCollection<T>(name: string): T[] {
      if (name === HISTORY_COLLECTION) return historyRepo.readAllOrdered(db) as T[];
      const col = COLLECTION_REPOS[name];
      if (col) return col.readAll(db) as T[];
      const doc = DOC_REPOS[name];
      if (doc) {
        const value = doc.read(db);
        return value === undefined ? [] : ([value] as T[]);
      }
      const parsed = readKv(name);
      if (parsed === undefined || parsed === null) return [];
      return parsed as T[];
    },

    readDoc<T>(name: string): T | undefined {
      if (name === HISTORY_COLLECTION) return historyRepo.readAllOrdered(db) as T;
      const col = COLLECTION_REPOS[name];
      if (col) return col.readAll(db) as T;
      const doc = DOC_REPOS[name];
      if (doc) return doc.read(db) as T | undefined;
      const parsed = readKv(name);
      if (parsed === undefined || parsed === null) return undefined;
      return parsed as T;
    },

    writeCollection<T>(name: string, rows: T[]): void {
      transact(() => writeDataset(name, rows as unknown[] | unknown));
    },

    appendHistory(rec: RunRecord): void {
      transact(() => {
        historyRepo.insert(db, rec);
        historyRepo.trim(db, MAX_HISTORY);
      });
    },

    getMeta,

    setMeta(key: string, value: string): void {
      transact(() => {
        db.prepare(
          'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        ).run(key, value);
      });
    },
  };
}

/**
 * Add columns to an existing `history` table when missing. Idempotent: each
 * `ALTER TABLE` runs only when `hasColumn` reports the column absent, so this is
 * a no-op once the columns exist (or for a fresh DB where SCHEMA_DDL already
 * created them). Covers `summary_*` (INTEGER) and `triggered_by` (TEXT).
 */
function ensureHistorySummaryColumns(db: DatabaseSync): void {
  for (const col of ['summary_passed', 'summary_failed', 'summary_skipped']) {
    if (!hasColumn(db, 'history', col)) {
      db.exec(`ALTER TABLE history ADD COLUMN ${col} INTEGER`);
    }
  }
  if (!hasColumn(db, 'history', 'triggered_by')) {
    db.exec('ALTER TABLE history ADD COLUMN triggered_by TEXT');
  }
  if (!hasColumn(db, 'history', 'output_stamp')) {
    db.exec('ALTER TABLE history ADD COLUMN output_stamp TEXT');
  }
  // `req_discard_report` joined the flattened RunRequest later than the rest, so
  // every table that embeds RUN_REQUEST_DDL needs it back-filled on an older DB.
  for (const table of ['history', 'schedules', 'bookmarks']) {
    if (tableExists(db, table) && !hasColumn(db, table, 'req_discard_report')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN req_discard_report INTEGER`);
    }
  }
}

/**
 * Read every legacy blob table into memory and DROP it, so the new normalized
 * schema can be (re)created cleanly. Returns the rescued items keyed by dataset
 * name (ready for `writeDataset`). Tables already in the new shape are left
 * untouched.
 */
function drainLegacyBlobTables(db: DatabaseSync): Record<string, unknown[]> {
  const stash: Record<string, unknown[]> = {};
  for (const { dataset, table, marker } of LEGACY_BLOB_TABLES) {
    if (!tableExists(db, table)) continue;
    if (!hasColumn(db, table, 'data')) continue; // not a blob table
    if (marker !== '__never__' && hasColumn(db, table, marker)) continue; // already new shape
    const rows = db.prepare(`SELECT data FROM ${table}`).all() as Row[];
    const items: unknown[] = [];
    for (const row of rows) {
      const text = asText(row.data);
      if (text === undefined) continue;
      try {
        items.push(JSON.parse(text));
      } catch {
        // Skip an unparseable legacy blob rather than abort the whole upgrade.
      }
    }
    stash[dataset] = items;
    db.exec(`DROP TABLE ${table}`);
  }
  return stash;
}

/**
 * Move any legacy `kv_store` rows whose dataset now has a normalized table into
 * that table, then delete the kv row. Idempotent: only datasets with a kv row
 * are touched. Datasets that legitimately stay in kv_store (matrix-runs,
 * k6-trends, flaky-tests, cleanup-history) are left alone.
 */
function migrateLegacyKvRows(
  db: DatabaseSync,
  transact: (fn: () => void) => void,
  writeDataset: (name: string, rows: unknown[] | unknown) => void,
): void {
  if (!tableExists(db, 'kv_store')) return;
  const normalizedNames = [
    HISTORY_COLLECTION,
    ...Object.keys(COLLECTION_REPOS),
    ...Object.keys(DOC_REPOS),
  ];
  for (const name of normalizedNames) {
    const row = db.prepare('SELECT data FROM kv_store WHERE name = ?').get(name) as Row | undefined;
    if (!row) continue;
    const text = asText(row.data);
    if (text === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    transact(() => {
      writeDataset(name, parsed as unknown[] | unknown);
      db.prepare('DELETE FROM kv_store WHERE name = ?').run(name);
    });
  }
}
