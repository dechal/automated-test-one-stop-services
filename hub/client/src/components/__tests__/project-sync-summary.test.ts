import { describe, expect, it } from 'vitest';
import { type ProjectSyncResult, summarizeProjectSync } from '../projects/project-sync-summary.js';

const t = (key: string): string => key.split('.').pop() ?? key;

function results(entries: [string, ProjectSyncResult['status']][]): ProjectSyncResult[] {
  return entries.map(([repo, status]) => ({ repo, status, message: '' }));
}

describe('summarizeProjectSync', () => {
  it('counts statuses and names no repo when everything is OK', () => {
    const out = summarizeProjectSync(
      results([
        ['a', 'already-up-to-date'],
        ['b', 'already-up-to-date'],
        ['c', 'synced'],
      ]),
      t,
    );
    expect(out).toEqual({ ok: true, message: '1 synced, 2 already-up-to-date' });
  });

  it('names only the non-OK repos', () => {
    const out = summarizeProjectSync(
      results([
        ['a', 'already-up-to-date'],
        ['tools/k6', 'failed'],
      ]),
      t,
    );
    expect(out).toEqual({ ok: false, message: '1 already-up-to-date, 1 failed: tools/k6' });
  });

  it('caps the named repos', () => {
    const out = summarizeProjectSync(
      results([
        ['r1', 'failed'],
        ['r2', 'failed'],
        ['r3', 'diverged'],
        ['r4', 'failed'],
        ['r5', 'failed'],
      ]),
      t,
    );
    expect(out.message).toBe('1 diverged, 4 failed: r1, r2, r3 +2');
  });
});
