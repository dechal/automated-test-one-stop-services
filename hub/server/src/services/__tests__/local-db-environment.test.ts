import type { RunRecord } from '@hub/shared';
import { describe, expect, it } from 'vitest';
import { openLocalDb } from '../local-db.js';

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
});
