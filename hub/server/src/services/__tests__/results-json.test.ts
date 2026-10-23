import fs, { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePneBreakdown, pneFromReportPath } from '../pne-parse.js';
import {
  invalidateResultsCache,
  RESULTS_CACHE_MAX_ENTRIES,
  readRunResults,
} from '../results-json.js';
import { parseRunOutcomes } from '../run-compare.js';
import { parseSeverityBreakdown, severityFromReportPath } from '../severity-parse.js';

interface SpecFixture {
  file: string;
  title?: string;
  ok?: boolean;
  tags?: string[];
}

/** Write a `<time>/results.json` with one suite of specs, return its report path. */
function writeReport(specs: SpecFixture[], suiteFile = 'specs/golf/positive.spec.ts'): string {
  const root = mkdtempSync(path.join(tmpdir(), 'rj-'));
  const htmlDir = path.join(root, 'html-results');
  mkdirSync(htmlDir, { recursive: true });
  writeFileSync(
    path.join(root, 'results.json'),
    JSON.stringify({
      suites: [
        {
          file: suiteFile,
          specs: specs.map((s) => ({
            title: s.title ?? 'a case',
            ok: s.ok ?? true,
            tags: s.tags ?? [],
          })),
        },
      ],
    }),
    'utf8',
  );
  return path.join(htmlDir, 'index.html');
}

function reportPathToResultsJson(reportPath: string): string {
  return path.join(path.dirname(path.dirname(reportPath)), 'results.json');
}

describe('readRunResults', () => {
  afterEach(() => {
    invalidateResultsCache();
    vi.restoreAllMocks();
  });

  it('reads the file once even when all three consumers run over one fixture', () => {
    const reportPath = writeReport([
      { file: 'specs/golf/positive.spec.ts', tags: ['critical'], ok: true },
      { file: 'specs/golf/positive.spec.ts', tags: ['high'], ok: false },
    ]);
    const spy = vi.spyOn(fs, 'readFileSync');

    const sev = severityFromReportPath(reportPath);
    const pne = pneFromReportPath(reportPath);
    const outcomes = parseRunOutcomes(reportPath);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(sev).not.toBeNull();
    expect(pne).toEqual({ positive: 2, negative: 0, edge: 0, unclassified: 0 });
    expect(outcomes).toHaveLength(2);
  });

  it('re-reads when the file mtime changes', () => {
    const reportPath = writeReport([{ file: 'x', tags: ['low'] }]);
    readRunResults(reportPath);
    const spy = vi.spyOn(fs, 'readFileSync');

    // Same version: a cache hit, no read.
    readRunResults(reportPath);
    expect(spy).toHaveBeenCalledTimes(0);

    // Touch the file forward in time → new mtime → re-read.
    const resultsJson = reportPathToResultsJson(reportPath);
    const future = new Date(Date.now() + 5000);
    utimesSync(resultsJson, future, future);
    readRunResults(reportPath);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('re-derives when the file size changes at the same mtime', () => {
    const reportPath = writeReport([{ file: 'x', tags: ['low'], ok: true }]);
    const resultsJson = reportPathToResultsJson(reportPath);
    const before = readRunResults(reportPath);
    expect(before.outcomes).toHaveLength(1);

    const stat = fs.statSync(resultsJson);
    writeFileSync(
      resultsJson,
      JSON.stringify({
        suites: [
          {
            file: 'x',
            specs: [
              { title: 'a', ok: true, tags: ['low'] },
              { title: 'b', ok: false, tags: ['high'] },
            ],
          },
        ],
      }),
      'utf8',
    );
    // Pin the mtime back so only the size differs.
    utimesSync(resultsJson, stat.atime, stat.mtime);

    const after = readRunResults(reportPath);
    expect(after.outcomes).toHaveLength(2);
  });

  it('returns a fully-null result for a missing results.json', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rj-missing-'));
    mkdirSync(path.join(root, 'html-results'), { recursive: true });
    const reportPath = path.join(root, 'html-results', 'index.html');
    expect(readRunResults(reportPath)).toEqual({ severity: null, pne: null, outcomes: null });
    expect(severityFromReportPath(reportPath)).toBeNull();
    expect(pneFromReportPath(reportPath)).toBeNull();
    expect(parseRunOutcomes(reportPath)).toBeNull();
  });

  it('returns null for an oversize results.json without parsing it', () => {
    const reportPath = writeReport([{ file: 'x', tags: ['low'] }]);
    const resultsJson = reportPathToResultsJson(reportPath);
    const statSpy = vi.spyOn(fs, 'statSync').mockReturnValue({
      mtimeMs: 1,
      size: 26 * 1024 * 1024,
    } as fs.Stats);
    const readSpy = vi.spyOn(fs, 'readFileSync');

    const result = readRunResults(reportPath);

    expect(result).toEqual({ severity: null, pne: null, outcomes: null });
    expect(readSpy).not.toHaveBeenCalled();
    statSpy.mockRestore();
    expect(fs.existsSync(resultsJson)).toBe(true);
  });

  it('returns a fully-null result for an unparseable results.json', () => {
    const reportPath = writeReport([{ file: 'x' }]);
    writeFileSync(reportPathToResultsJson(reportPath), '{ not json', 'utf8');
    invalidateResultsCache();
    expect(readRunResults(reportPath)).toEqual({ severity: null, pne: null, outcomes: null });
  });

  it('keeps the derived signatures the three consumers expect', () => {
    const reportPath = writeReport(
      [{ file: 'specs/golf/negative.spec.ts', tags: ['critical'], ok: false, title: 'C1: a' }],
      'specs/golf/negative.spec.ts',
    );
    // parseSeverityBreakdown / parsePneBreakdown take the results.json path directly.
    const resultsJson = reportPathToResultsJson(reportPath);
    expect(parseSeverityBreakdown(resultsJson)?.critical).toEqual({ passed: 0, failed: 1 });
    expect(parsePneBreakdown(resultsJson)?.negative).toBe(1);
    expect(parseRunOutcomes(reportPath)?.[0]?.status).toBe('failed');
  });

  it('evicts the oldest entry past the cache cap', () => {
    // Prime the cap with distinct file versions, then confirm the first evicts.
    const first = writeReport([{ file: 'x', tags: ['low'] }]);
    readRunResults(first);
    for (let i = 0; i < RESULTS_CACHE_MAX_ENTRIES; i += 1) {
      readRunResults(writeReport([{ file: `f${i}`, tags: ['low'] }]));
    }
    const spy = vi.spyOn(fs, 'readFileSync');
    readRunResults(first);
    // The first entry was pushed out, so this is a miss and reads again.
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
