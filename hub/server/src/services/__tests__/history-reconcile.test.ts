import type { RunRecord } from '@hub/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rows: RunRecord[] = [];

vi.mock('../db.js', () => ({
  getDb: () => ({
    readCollection: () => rows.map((r) => ({ ...r })),
    appendHistory: (rec: RunRecord) => {
      const at = rows.findIndex((r) => r.id === rec.id);
      if (at >= 0) rows[at] = { ...rec };
      else rows.unshift({ ...rec });
    },
    writeCollection: () => {
      rows.length = 0;
    },
  }),
}));

const { historyStore } = await import('../history-store.js');

function run(id: string, status: RunRecord['status']): RunRecord {
  return {
    id,
    status,
    command: 'task pw:run-local',
    startedAt: '2026-09-09T07:05:03.000Z',
    request: { tool: 'playwright', type: 'web', project: 'shop', mode: 'local' },
  } as RunRecord;
}

describe('reconcileInterrupted — a Hub restart must not leave a run stuck as running', () => {
  beforeEach(() => {
    historyStore.clear();
  });

  it('turns an orphaned running/pending row into a terminal error row', () => {
    rows.push(run('a', 'running'), run('b', 'pending'), run('c', 'passed'));

    const reconciled = historyStore.reconcileInterrupted();

    expect(reconciled.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(rows.find((r) => r.id === 'a')?.status).toBe('error');
    expect(rows.find((r) => r.id === 'b')?.status).toBe('error');
    expect(rows.find((r) => r.id === 'a')?.endedAt).toBeTruthy();
  });

  it('leaves a finished row untouched', () => {
    rows.push(run('c', 'passed'));
    expect(historyStore.reconcileInterrupted()).toEqual([]);
    expect(rows.find((r) => r.id === 'c')?.status).toBe('passed');
  });

  it('is idempotent — a second boot finds nothing left to reconcile', () => {
    rows.push(run('a', 'running'));
    expect(historyStore.reconcileInterrupted()).toHaveLength(1);
    expect(historyStore.reconcileInterrupted()).toEqual([]);
  });
});
