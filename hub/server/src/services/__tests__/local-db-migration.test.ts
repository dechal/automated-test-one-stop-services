import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasColumn } from '../db-schema.js';
import { openLocalDb } from '../local-db.js';

/**
 * Migration guard for FEAT-001's three new columns. Opens a FILE DB seeded with
 * the PRE-change DDL (env_profiles without is_default / allow_outside_template,
 * schedules without env_profile_id) plus a row of real data, then reopens it
 * through `openLocalDb` and asserts the guarded ALTER TABLE back-fill added the
 * columns while the existing rows survived.
 *
 * Uses a real on-disk SQLite file (not ':memory:') so the close/reopen genuinely
 * re-reads persisted state. node:sqlite keeps a file lock until the process
 * exits, so cleanup is best-effort (mirrors local-db-boot.test.ts).
 */

const OLD_SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE env_profiles (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    environment TEXT NOT NULL,
    tool        TEXT NOT NULL,
    type        TEXT NOT NULL,
    project     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE TABLE env_profile_entries (
    profile_id TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    PRIMARY KEY (profile_id, key)
  );
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
    req_tool     TEXT,
    req_type     TEXT,
    req_project  TEXT,
    req_mode     TEXT
  );
`;

describe('openLocalDb migration — FEAT-001 columns', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-migration-'));
    dbPath = path.join(tmpDir, 'hub.db');

    const seed = new DatabaseSync(dbPath);
    seed.exec(OLD_SCHEMA);
    // Seed a schema version BELOW current so the upgrade path is NOT taken as a
    // legacy blob drain — these tables are already the normalized shape, only
    // missing the new columns. The marker column (`name`) is present, so the
    // drain loop skips them; the hasColumn-guarded ALTER is what must run.
    seed.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '2');
    seed
      .prepare(
        'INSERT INTO env_profiles (id, name, environment, tool, type, project, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('old-1', 'legacy', 'dev', 'playwright', 'web', 'demo', 'c', 'u');
    seed
      .prepare('INSERT INTO env_profile_entries (profile_id, key, value) VALUES (?, ?, ?)')
      .run('old-1', 'API_URL', 'https://example.test');
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

  it('adds the three new columns after open', () => {
    openLocalDb(dbPath);

    const check = new DatabaseSync(dbPath);
    expect(hasColumn(check, 'env_profiles', 'is_default')).toBe(true);
    expect(hasColumn(check, 'env_profiles', 'allow_outside_template')).toBe(true);
    expect(hasColumn(check, 'schedules', 'env_profile_id')).toBe(true);
  });

  it('preserves existing rows across the migration', () => {
    const db = openLocalDb(dbPath);

    const profiles = db.readCollection<{
      id: string;
      name: string;
      entries: Record<string, string>;
      isDefault?: boolean;
      allowOutsideTemplate?: boolean;
    }>('env-profiles.json');
    const profile = profiles.find((p) => p.id === 'old-1');
    expect(profile?.name).toBe('legacy');
    expect(profile?.entries).toEqual({ API_URL: 'https://example.test' });
    // A pre-existing row has NULL in the new columns → absent, not false.
    expect(profile?.isDefault).toBeUndefined();
    expect(profile?.allowOutsideTemplate).toBeUndefined();

    const schedules = db.readCollection<{ id: string; name: string; envProfileId?: string }>(
      'schedules.json',
    );
    const schedule = schedules.find((s) => s.id === 'sch-1');
    expect(schedule?.name).toBe('nightly');
    expect(schedule?.envProfileId).toBeUndefined();
  });
});
