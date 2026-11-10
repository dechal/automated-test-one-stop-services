import type { RunRecord } from '@hub/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let rows: RunRecord[] = [];

vi.mock('../db.js', () => ({
  getDb: () => ({
    readCollection: () => rows.map((r) => ({ ...r })),
    writeCollection: (_name: string, next: RunRecord[]) => {
      rows = next.map((r) => ({ ...r }));
    },
  }),
}));

const { historyStore } = await import('../history-store.js');

function run(id: string, tool: string): RunRecord {
  return {
    id,
    status: 'passed',
    command: 'task run',
    startedAt: '2026-11-10T02:00:00.000Z',
    request: { tool, type: 'desktop', project: 'iia', mode: 'local' },
  } as RunRecord;
}

describe('historyStore.removeWhere', () => {
  beforeEach(() => {
    historyStore.clear();
    rows = [run('r1', 'robot-framework'), run('p1', 'pywinauto'), run('r2', 'robot-framework')];
  });

  it('removes only matching rows and persists the rest', () => {
    const removed = historyStore.removeWhere((r) => r.request.tool === 'robot-framework');

    expect(removed).toBe(2);
    expect(rows.map((r) => r.id)).toEqual(['p1']);
    expect(historyStore.getAll().map((r) => r.id)).toEqual(['p1']);
  });

  it('writes nothing when no row matches', () => {
    const before = rows;
    expect(historyStore.removeWhere(() => false)).toBe(0);
    expect(rows).toBe(before);
  });
});
