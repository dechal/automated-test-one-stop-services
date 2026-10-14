import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyPne, pneFromReportPath } from '../pne-parse.js';

function writeReport(suites: { file: string; specCount: number }[]): string {
  const root = mkdtempSync(path.join(tmpdir(), 'pne-'));
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

describe('classifyPne', () => {
  it('classifies by a path segment', () => {
    expect(classifyPne('specs/golf/positive.spec.ts')).toBe('positive');
    expect(classifyPne('negative/foo.spec.ts')).toBe('negative');
  });

  it('classifies by the filename stem', () => {
    expect(classifyPne('edge.spec.ts')).toBe('edge');
  });

  it('is case-insensitive', () => {
    expect(classifyPne('specs/Positive.spec.ts')).toBe('positive');
  });

  it('returns unclassified for a path with none of the tokens', () => {
    expect(classifyPne('specs/smoke.spec.ts')).toBe('unclassified');
    expect(classifyPne(undefined)).toBe('unclassified');
  });

  it('matches segment-exact, so a positive-flow project does not misclassify', () => {
    expect(classifyPne('projects/positive-flow/specs/smoke.spec.ts')).toBe('unclassified');
  });
});

describe('pneFromReportPath', () => {
  it('counts each bucket and sums to the executed spec total', () => {
    const reportPath = writeReport([
      { file: 'specs/golf/positive.spec.ts', specCount: 12 },
      { file: 'specs/golf/negative.spec.ts', specCount: 8 },
      { file: 'specs/golf/edge.spec.ts', specCount: 5 },
      { file: 'specs/golf/smoke.spec.ts', specCount: 3 },
    ]);

    const pne = pneFromReportPath(reportPath);

    expect(pne).toEqual({ positive: 12, negative: 8, edge: 5, unclassified: 3 });
    const total =
      (pne?.positive ?? 0) + (pne?.negative ?? 0) + (pne?.edge ?? 0) + (pne?.unclassified ?? 0);
    expect(total).toBe(28);
  });

  it('returns null when the run has no results.json', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pne-empty-'));
    mkdirSync(path.join(root, 'html-results'), { recursive: true });
    expect(pneFromReportPath(path.join(root, 'html-results', 'index.html'))).toBeNull();
  });

  it('returns null for an empty suites array', () => {
    const reportPath = writeReport([]);
    expect(pneFromReportPath(reportPath)).toBeNull();
  });
});
