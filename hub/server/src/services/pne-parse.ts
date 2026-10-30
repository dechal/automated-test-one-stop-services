import path from 'node:path';
import type { PneBreakdown } from '@hub/shared';
import { classifyPne, readRunResults } from './results-json.js';

export { classifyPne };

/**
 * Parse the P/N/E breakdown from a Playwright `results.json`.
 * `resultsJsonPath` points directly at the file; the shared reader expects the
 * report HTML path, so reconstruct it (`<dir>/html-results/index.html`) —
 * `readRunResults` only uses it to re-derive the same `results.json` path.
 * Parsing + caching + the single pass live in `results-json.ts`.
 */
export function parsePneBreakdown(resultsJsonPath: string): PneBreakdown | null {
  const timeDir = path.dirname(resultsJsonPath);
  return readRunResults(path.join(timeDir, 'html-results', 'index.html')).pne;
}

export function pneFromReportPath(reportPath: string | undefined): PneBreakdown | null {
  return readRunResults(reportPath).pne;
}
