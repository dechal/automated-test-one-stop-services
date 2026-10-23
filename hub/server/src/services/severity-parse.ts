import path from 'node:path';
import type { SeverityBreakdown } from '@hub/shared';
import { readRunResults } from './results-json.js';

// ===========================================================================
// Per-severity pass/fail tally parsed from a Playwright `results.json`.
// Shared by the report listing (reports.ts) and the run history route so both
// derive the severity-weighted score from the same source. Parsing + caching
// live in `results-json.ts`, which derives severity in one pass with pne and
// outcomes so the file is read once per version across all three consumers.
// ===========================================================================

/**
 * Parse the per-severity passed/failed tally from a Playwright `results.json`.
 * `resultsJsonPath` points directly at the `results.json`; the shared reader
 * expects the report HTML path, so reconstruct it (`<dir>/html-results/
 * index.html`) — `readRunResults` only uses it to re-derive the same
 * `results.json` path.
 * Best-effort: a missing/oversized/malformed file yields `null` (the caller
 * falls back to a plain pass rate) rather than throwing.
 */
export function parseSeverityBreakdown(resultsJsonPath: string): SeverityBreakdown | null {
  const timeDir = path.dirname(resultsJsonPath);
  return readRunResults(path.join(timeDir, 'html-results', 'index.html')).severity;
}

/**
 * Resolve a Playwright report's `results.json` (written by the `json` reporter
 * into the run's time dir) from the report's HTML path, then parse it.
 * `reportPath` is `.../<time>/html-results/index.html`; `results.json` sits in
 * `<time>/`. Returns `null` when the path shape is unexpected or the file is
 * missing/unparseable.
 */
export function severityFromReportPath(reportPath: string | undefined): SeverityBreakdown | null {
  return readRunResults(reportPath).severity;
}
