import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasColumn } from '../db-schema.js';
import { openLocalDb } from '../local-db.js';

/**
 * Migration guard for the P1 custom-schedule command columns. Opens a FILE DB
 * seeded with the PRE-change `schedules` DDL (no cmd_script/cmd_args/cmd_cwd)
 * plus one existing row, then reopens it through `openLocalDb` and asserts the
 * guarded ALTER TABLE back-fill added the columns while the existing row
 * survived with `command` absent (NULL cmd_script ⇒ tool schedule, unchanged).
 *
 * Uses a real on-disk SQLite file (not ':memory:') so close/reopen genuinely
 * re-reads persisted state. node:sqlite keeps a file lock until the process
 * exits, so cleanup is best-effort (mirrors local-db-migration.test.ts).
 */

const OLD_SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE schedules (
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
    env_profile_id TEXT,
    req_tool     TEXT,
    req_type     TEXT,
    req_project  TEXT,
    req_mode     TEXT
  );
`;

describe('openLocalDb migration — schedule command columns', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-cmd-migration-'));
    dbPath = path.join(tmpDir, 'hub.db');

    const seed = new DatabaseSync(dbPath);
    seed.exec(OLD_SCHEMA);
    // schema_version below current so the drain path is NOT taken — the table
    // is already the normalized shape (marker column `name` present), only
    // missing the new columns; the hasColumn-guarded ALTER is what must run.
    seed.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '2');
    seed
      .prepare(
        'INSERT INTO schedules (id, name, cron, enabled, created_at, req_tool, req_type, req_project, req_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('sch-1', 'nightly', '0 0 * * *', 1, 'c', 'playwright', 'web', 'demo', 'local');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // node:sqlite holds the file lock on Windows until the process exits.
    }
  });

  it('adds the three command columns after open', () => {
    openLocalDb(dbPath);

    const check = new DatabaseSync(dbPath);
    expect(hasColumn(check, 'schedules', 'cmd_script')).toBe(true);
    expect(hasColumn(check, 'schedules', 'cmd_args')).toBe(true);
    expect(hasColumn(check, 'schedules', 'cmd_cwd')).toBe(true);
  });

  it('preserves the existing row with command absent across the migration', () => {
    const db = openLocalDb(dbPath);

    const schedules = db.readCollection<{
      id: string;
      name: string;
      command?: { script: string };
    }>('schedules.json');
    const schedule = schedules.find((s) => s.id === 'sch-1');
    expect(schedule?.name).toBe('nightly');
    // NULL cmd_script ⇒ command absent ⇒ tool schedule, unchanged.
    expect(schedule?.command).toBeUndefined();
  });
});
