import fs from 'node:fs';
import path from 'node:path';
import type { PneBreakdown } from '@hub/shared';

export type PneBucket = 'positive' | 'negative' | 'edge' | 'unclassified';

interface PwSpec {
  file?: string;
}
interface PwSuite {
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}

const PNE_TOKENS = new Set<PneBucket>(['positive', 'negative', 'edge']);

export function classifyPne(file: string | undefined): PneBucket {
  if (!file) return 'unclassified';
  const segments = file.replace(/\\/g, '/').split('/').filter(Boolean);
  for (const raw of segments) {
    const segment = raw.toLowerCase();
    if (PNE_TOKENS.has(segment as PneBucket)) return segment as PneBucket;
    const stem = segment.split('.')[0] ?? '';
    if (PNE_TOKENS.has(stem as PneBucket)) return stem as PneBucket;
  }
  return 'unclassified';
}

function collectFiles(
  suite: PwSuite,
  fileHint: string | undefined,
  out: (string | undefined)[],
): void {
  const file = suite.file ?? fileHint;
  for (const spec of suite.specs ?? []) out.push(spec.file ?? file);
  for (const child of suite.suites ?? []) collectFiles(child, file, out);
}

const pneCache = new Map<string, { mtimeMs: number; breakdown: PneBreakdown | null }>();
const MAX_RESULTS_JSON_BYTES = 25 * 1024 * 1024;

export function parsePneBreakdown(resultsJsonPath: string): PneBreakdown | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resultsJsonPath);
  } catch {
    return null;
  }
  const cached = pneCache.get(resultsJsonPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.breakdown;

  let breakdown: PneBreakdown | null = null;
  if (stat.size <= MAX_RESULTS_JSON_BYTES) {
    try {
      const json = JSON.parse(fs.readFileSync(resultsJsonPath, 'utf8')) as { suites?: PwSuite[] };
      const files: (string | undefined)[] = [];
      for (const suite of json.suites ?? []) collectFiles(suite, undefined, files);
      if (files.length === 0) {
        breakdown = null;
      } else {
        const acc: PneBreakdown = { positive: 0, negative: 0, edge: 0, unclassified: 0 };
        for (const file of files) acc[classifyPne(file)] += 1;
        breakdown = acc;
      }
    } catch {
      breakdown = null;
    }
  }
  pneCache.set(resultsJsonPath, { mtimeMs: stat.mtimeMs, breakdown });
  return breakdown;
}

export function pneFromReportPath(reportPath: string | undefined): PneBreakdown | null {
  if (!reportPath) return null;
  const timeDir = path.dirname(path.dirname(reportPath));
  return parsePneBreakdown(path.join(timeDir, 'results.json'));
}
