import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { RunRecord } from '@hub/shared';
import { describe, expect, it } from 'vitest';
import { hasColumn, SCHEMA_VERSION, SCHEMA_VERSION_KEY } from '../db-schema.js';
import { openLocalDb } from '../local-db.js';

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'hub-env-db-'));
  return path.join(dir, 'hub.db');
}

function makeRecord(environment: string | undefined, envProfileName?: string): RunRecord {
  return {
    id: `run-${environment ?? 'none'}`,
    request: { tool: 'playwright', type: 'web', project: 'demo', mode: 'local' },
    command: 'task test',
    status: 'passed',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    exitCode: 0,
    ...(environment !== undefined ? { environment } : {}),
    ...(envProfileName !== undefined ? { envProfileName } : {}),
  };
}

describe('history.environment round-trip', () => {
  it('persists and reads back a concrete environment label', () => {
    const db = openLocalDb(':memory:');
    db.appendHistory(makeRecord('prod'));
    const row = db.readCollection<RunRecord>('history').find((r) => r.id === 'run-prod');
    expect(row?.environment).toBe('prod');
  });

  it('round-trips an absent environment as undefined, not an empty string', () => {
    const db = openLocalDb(':memory:');
    db.appendHistory(makeRecord(undefined));
    const row = db.readCollection<RunRecord>('history').find((r) => r.id === 'run-none');
    expect(row?.environment).toBeUndefined();
  });

  it('back-fills the column on a legacy DB and reads the old row as undefined', () => {
    const dbPath = tempDbPath();

    const seed = new DatabaseSync(dbPath);
    seed.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    seed
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run(SCHEMA_VERSION_KEY, String(SCHEMA_VERSION));
    seed.exec(
      `CREATE TABLE history (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, command TEXT NOT NULL,
        started_at TEXT NOT NULL, ended_at TEXT, exit_code INTEGER, report_path TEXT,
        output_stamp TEXT, summary_passed INTEGER, summary_failed INTEGER,
        summary_skipped INTEGER, triggered_by TEXT,
        req_tool TEXT, req_type TEXT, req_project TEXT, req_mode TEXT, req_tag TEXT,
        req_headless TEXT, req_extra_args TEXT, req_no_track INTEGER, req_silent INTEGER,
        req_discard_report INTEGER, req_section TEXT, req_performance_type TEXT
      )`,
    );
    seed
      .prepare(
        'INSERT INTO history (id, status, command, started_at, req_tool, req_type, req_project, req_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        'old-run',
        'passed',
        'task test',
        '2026-01-01T00:00:00.000Z',
        'playwright',
        'web',
        'demo',
        'local',
      );
    expect(hasColumn(seed, 'history', 'environment')).toBe(false);
    seed.close();

    const db = openLocalDb(dbPath);
    const row = db.readCollection<RunRecord>('history').find((r) => r.id === 'old-run');
    expect(row).toBeDefined();
    expect(row?.environment).toBeUndefined();

    const check = new DatabaseSync(dbPath);
    expect(hasColumn(check, 'history', 'environment')).toBe(true);
    check.close();
  });
});

describe('history.envProfileName round-trip', () => {
  it('persists and reads back a concrete env profile name', () => {
    const db = openLocalDb(':memory:');
    db.appendHistory(makeRecord('dev', 'Main Dev'));
    const row = db.readCollection<RunRecord>('history').find((r) => r.id === 'run-dev');
    expect(row?.environment).toBe('dev');
    expect(row?.envProfileName).toBe('Main Dev');
  });

  it('round-trips an absent env profile name as undefined, not an empty string', () => {
    const db = openLocalDb(':memory:');
    db.appendHistory(makeRecord('dev'));
    const row = db.readCollection<RunRecord>('history').find((r) => r.id === 'run-dev');
    expect(row?.envProfileName).toBeUndefined();
  });

  it('back-fills env_profile_name on a legacy DB and reads the old row as undefined', () => {
    const dbPath = tempDbPath();

    const seed = new DatabaseSync(dbPath);
    seed.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    seed
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run(SCHEMA_VERSION_KEY, String(SCHEMA_VERSION));
    seed.exec(
      `CREATE TABLE history (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, command TEXT NOT NULL,
        started_at TEXT NOT NULL, ended_at TEXT, exit_code INTEGER, report_path TEXT,
        output_stamp TEXT, summary_passed INTEGER, summary_failed INTEGER,
        summary_skipped INTEGER, triggered_by TEXT, environment TEXT,
        req_tool TEXT, req_type TEXT, req_project TEXT, req_mode TEXT, req_tag TEXT,
        req_headless TEXT, req_extra_args TEXT, req_no_track INTEGER, req_silent INTEGER,
        req_discard_report INTEGER, req_section TEXT, req_performance_type TEXT
      )`,
    );
    seed
      .prepare(
        'INSERT INTO history (id, status, command, started_at, environment, req_tool, req_type, req_project, req_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        'old-run',
        'passed',
        'task test',
        '2026-01-01T00:00:00.000Z',
        'prod',
        'playwright',
        'web',
        'demo',
        'local',
      );
    expect(hasColumn(seed, 'history', 'env_profile_name')).toBe(false);
    seed.close();

    const db = openLocalDb(dbPath);
    const old = db.readCollection<RunRecord>('history').find((r) => r.id === 'old-run');
    expect(old).toBeDefined();
    expect(old?.environment).toBe('prod');
    expect(old?.envProfileName).toBeUndefined();

    db.appendHistory(makeRecord('dev', 'Main Dev'));
    const written = db.readCollection<RunRecord>('history').find((r) => r.id === 'run-dev');
    expect(written?.envProfileName).toBe('Main Dev');

    const check = new DatabaseSync(dbPath);
    expect(hasColumn(check, 'history', 'env_profile_name')).toBe(true);
    check.close();
  });

  it('adds env_profile_name to a COPY of the real hub.db and reads old rows back as undefined', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const liveDb = path.resolve(here, '..', '..', '..', 'data', 'hub.db');
    if (!existsSync(liveDb)) return;

    const copyPath = tempDbPath();
    copyFileSync(liveDb, copyPath);

    const before = new DatabaseSync(copyPath);
    const hadColumn = hasColumn(before, 'history', 'env_profile_name');
    const legacyIds = hadColumn
      ? []
      : (before.prepare('SELECT id FROM history').all() as Array<{ id: string }>).map((r) => r.id);
    before.close();

    const db = openLocalDb(copyPath);

    const check = new DatabaseSync(copyPath);
    expect(hasColumn(check, 'history', 'env_profile_name')).toBe(true);
    check.close();

    if (!hadColumn && legacyIds.length > 0) {
      const rows = db.readCollection<RunRecord>('history');
      for (const id of legacyIds) {
        const row = rows.find((r) => r.id === id);
        if (row) expect(row.envProfileName).toBeUndefined();
      }
    }
  });
});
