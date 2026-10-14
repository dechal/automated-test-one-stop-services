import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ReportEntry } from '@hub/shared';
import { describe, expect, it } from 'vitest';
import { applyPneToEntry } from '../reports.js';

function writeReport(suites: { file: string; specCount: number }[]): string {
  const root = mkdtempSync(path.join(tmpdir(), 'reports-pne-'));
  const htmlDir = path.join(root, 'html-results');
  mkdirSync(htmlDir, { recursive: true });
  writeFileSync(
    path.join(root, 'results.json'),
    JSON.stringify({
      suites: suites.map((s) => ({
        file: s.file,
        specs: Array.from({ length: s.specCount }, () => ({ ok: true })),
      })),
    }),
    'utf8',
  );
  return path.join(htmlDir, 'index.html');
}

function entry(over: Partial<ReportEntry>): ReportEntry {
  return {
    id: 'e1',
    tool: 'playwright',
    type: 'web',
    project: 'demo',
    status: 'success',
    reportPath: '',
    timestamp: '2026-01-01T00:00:00.000Z',
    locked: false,
    favorite: false,
    summary: { passed: 1, failed: 0 },
    ...over,
  };
}

describe('applyPneToEntry', () => {
  it('sets summary.pne for a Playwright entry with a readable results.json', () => {
    const reportPath = writeReport([
      { file: 'specs/positive.spec.ts', specCount: 2 },
      { file: 'specs/edge.spec.ts', specCount: 1 },
    ]);
    const e = entry({ reportPath });
    applyPneToEntry(e);
    expect(e.summary?.pne).toEqual({ positive: 2, negative: 0, edge: 1, unclassified: 0 });
  });

  it('leaves a non-Playwright entry untouched', () => {
    const reportPath = writeReport([{ file: 'specs/positive.spec.ts', specCount: 2 }]);
    const e = entry({ tool: 'k6', reportPath });
    applyPneToEntry(e);
    expect(e.summary?.pne).toBeUndefined();
  });

  it('leaves a summary-less entry untouched', () => {
    const reportPath = writeReport([{ file: 'specs/positive.spec.ts', specCount: 2 }]);
    const e = entry({ reportPath, summary: undefined });
    applyPneToEntry(e);
    expect(e.summary).toBeUndefined();
  });
});
