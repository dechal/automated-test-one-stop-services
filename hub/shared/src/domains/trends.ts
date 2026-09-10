import type { TestStatus } from './compare.js';

/** One test's outcome at a point in time, for the trend sparkline. */
export interface TrendPoint {
  runId: string;
  /** ISO timestamp of the run that produced this outcome (report time). */
  at: string;
  status: TestStatus;
}

/**
 * One test's history across the retained Playwright runs of a project, keyed by
 * the stable Playwright `spec.id` (falls back to `file::title`). `flips` counts
 * status changes between consecutive points; `flakinessScore` is the percentage
 * of adjacent pairs that differ, so a consistently-failing test scores 0.
 */
export interface TestTrend {
  key: string;
  title: string;
  file?: string;
  /** Case id when the spec carries one (tag or `<ID>:` title prefix). */
  caseId?: string;
  totalRuns: number;
  passes: number;
  failures: number;
  passRate: number;
  flips: number;
  flakinessScore: number;
  isFlaky: boolean;
  /** Newest last, so the client renders a left-to-right timeline. */
  points: TrendPoint[];
  lastStatus: TestStatus;
  lastSeen: string;
}

/**
 * Per-test trend report for one Playwright project. `unavailable` is true when
 * no run in scope produced a parseable `results.json` (non-Playwright tool,
 * silent/discarded runs, or aged-out artifacts), so the client shows an
 * explanation rather than an empty table.
 */
export interface TestTrendReport {
  generatedAt: string;
  tool: string;
  type: string;
  project: string;
  /** Runs that contributed at least one parseable outcome. */
  runsAnalyzed: number;
  totalTests: number;
  flakyCount: number;
  tests: TestTrend[];
  unavailable: boolean;
}
