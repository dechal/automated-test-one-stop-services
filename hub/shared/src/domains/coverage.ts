/** Latest-run outcome for one documented test case. */
export type CoverageOutcome = 'passed' | 'failed' | 'not-run';

/** One documented test case joined to its latest run outcome. */
export interface CoverageCase {
  /** `Test Case ID` from the doc row. */
  caseId: string;
  /** `Test Scenario` from the doc row, for display. */
  scenario: string;
  /** `Requirement Ref ID` cell, verbatim (may be empty, `N/A`, or comma-packed). */
  requirementRef: string;
  /** Basename of the doc the case lives in. */
  doc: string;
  outcome: CoverageOutcome;
}

/**
 * Cases grouped under one requirement token. `requirement` is a single value
 * split out of the doc's `Requirement Ref ID` column; the sentinel
 * `__unmapped__` collects rows whose column is empty or `N/A`.
 */
export interface CoverageGroup {
  requirement: string;
  cases: CoverageCase[];
  total: number;
  passed: number;
  failed: number;
  notRun: number;
}

/**
 * Coverage matrix for one project: documented test cases (rows of its
 * test-case docs) joined to the latest run's per-case outcome. This is a
 * COVERAGE matrix, not a requirement-traceability one: there is no independent
 * requirement catalogue in the workspace, so `groups` are derived best-effort
 * from the free-text `Requirement Ref ID` column — a project that leaves it
 * blank/`N/A` collapses into the single `__unmapped__` group. `hasRun` is false
 * when no run outcome could be joined (non-Playwright, or no results on disk),
 * so the client shows every case as `not-run` and says why.
 */
export interface CoverageReport {
  generatedAt: string;
  tool: string;
  type: string;
  project: string;
  totalCases: number;
  passed: number;
  failed: number;
  notRun: number;
  /** Cases whose id was found in the latest run, of `totalCases`. */
  covered: number;
  groups: CoverageGroup[];
  hasRun: boolean;
}

/** Sentinel requirement key for cases with no `Requirement Ref ID`. */
export const COVERAGE_UNMAPPED = '__unmapped__';
