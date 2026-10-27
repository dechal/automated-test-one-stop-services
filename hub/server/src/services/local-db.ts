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
import { type Row, SCHEMA_DDL, SCHEMA_VERSION, SCHEMA_VERSION_KEY } from './db-schema.js';

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

  // Prepare the normalized schema (idempotent).
  db.exec(SCHEMA_DDL);

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
