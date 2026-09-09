import type { RunRecord } from '@hub/shared';
import { getDb } from './db.js';

/**
 * Run-history store.
 *
 * The backing store is now the embedded Local_DB (node:sqlite) shared via
 * `getDb()` — NOT the old `history.ndjson` / `history.json` files. The PUBLIC
 * API is unchanged (`append` / `getAll` / `clear` / `flush`) so the runner
 * keeps working without any contract changes.
 *
 * Storage: every record lives in the dedicated, NORMALIZED `history` table —
 * one row per RunRecord with typed columns (status, command, timestamps,
 * exit_code, report_path, and the flattened `req_*` request columns). Reads
 * come back ordered newest first; `appendHistory` inserts then trims to
 * MAX_HISTORY=200.
 *
 * Silent runs: the no-trace gate lives entirely in the runner. The
 * runner only calls `historyStore.append` for NON-silent runs, so a silent run
 * never reaches this store and never touches Local_DB. This file
 * deliberately adds NO silent-specific logic — it simply persists whatever it
 * is given.
 */
class HistoryStore {
  /**
   * Memoized snapshot of the last `getAll()` read. `readCollection('history')`
   * re-queries and re-materializes up to MAX_HISTORY=200 rows on every call,
   * and this store is read on several polled endpoints (/api/runs/history,
   * last-status, reports enrichment, flaky). The cache is invalidated on every
   * write (`append`/`clear`), so it can never go stale. Consumers treat the
   * result as read-only (they filter into new arrays), so sharing the snapshot
   * reference is safe.
   */
  private cache: RunRecord[] | null = null;

  /**
   * Get all records (newest first, capped at MAX_HISTORY).
   * `readCollection('history')` returns rows ordered by `started_at DESC` as a
   * deep clone; the snapshot is memoized until the next write.
   */
  getAll(): RunRecord[] {
    if (this.cache === null) {
      this.cache = getDb().readCollection<RunRecord>('history');
    }
    return this.cache;
  }

  /**
   * Append a finished run record. `appendHistory` inserts inside a transaction
   * then trims the table back to the newest MAX_HISTORY=200 records.
   *
   * Only called for non-silent runs (the runner gates this) — see class docs.
   */
  append(record: RunRecord): void {
    getDb().appendHistory(record);
    this.cache = null; // invalidate memoized snapshot
  }

  /** Clear all history (manual user action) by writing an empty collection. */
  clear(): void {
    getDb().writeCollection<RunRecord>('history', []);
    this.cache = null; // invalidate memoized snapshot
  }

  reconcileInterrupted(): RunRecord[] {
    const stale = this.getAll().filter((r) => r.status === 'running' || r.status === 'pending');
    if (stale.length === 0) return [];
    for (const record of stale) {
      getDb().appendHistory({
        ...record,
        status: 'error',
        endedAt: record.endedAt ?? new Date().toISOString(),
      });
    }
    this.cache = null;
    return stale;
  }

  /**
   * Force flush (for graceful shutdown). node:sqlite writes are synchronous and
   * already committed by the time `append`/`clear` return, so there is nothing
   * to await. Kept async to preserve the public contract.
   */
  async flush(): Promise<void> {
    // No-op: writes are committed synchronously.
  }
}

export const historyStore = new HistoryStore();
