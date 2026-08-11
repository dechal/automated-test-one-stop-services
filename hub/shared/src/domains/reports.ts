import type { RunSummary } from './run-summary.js';
import type { PerformanceType } from './runs.js';
import type { SeverityBreakdown } from './severity-score.js';
import type { ToolId } from './tools.js';

// Reports --------------------------------------------------------------------

export interface ReportEntry {
  id: string;
  tool: ToolId;
  type: string;
  project: string;
  status: 'success' | 'error' | 'unknown';
  reportPath: string;
  timestamp: string;
  /**
   * Protected from auto-cleanup. Always true while {@link favorite} is set —
   * favouriting is a stronger statement than locking, so it implies the lock and
   * the lock cannot be released underneath it.
   */
  locked: boolean;
  /**
   * Marked as a keeper by the user. Forces {@link locked} and disables the
   * lock/unlock control until the favourite is removed, so there is no way to
   * end up with a favourite that cleanup is allowed to delete.
   */
  favorite: boolean;
  /**
   * Test-case counts for the run that produced this report, joined from run
   * history. Absent when no matching run is in history (e.g. an old report
   * whose run has aged out of the capped history).
   */
  summary?: RunSummary;
  /**
   * Per-severity passed/failed tally, parsed from the runner's machine-readable
   * result file (Playwright `results.json`). Drives the severity-weighted pass
   * score. Absent for tools with no per-test severity (k6) or when the result
   * file is missing/unparseable.
   */
  severity?: SeverityBreakdown;
  /**
   * Wall-clock run duration in milliseconds, derived from the matched run's
   * startedAt/endedAt. Absent when the run has not finished or aged out.
   */
  durationMs?: number;
  /**
   * Tag expression the run was launched with (from RunRequest.tag). Absent when
   * the run was launched without a tag filter (all tests).
   */
  runTag?: string;
  /**
   * Run mode (local | docker) from the matched run request.
   */
  runMode?: string;
}

export interface ReportAnnotation {
  id: string;
  reportId: string;
  author: string;
  /** Annotation content (markdown supported). */
  content: string;
  type: 'note' | 'bug' | 'improvement' | 'question';
  createdAt: string;
  updatedAt?: string;
}

// Artifacts ------------------------------------------------------------------

export type ArtifactType = 'screenshot' | 'video' | 'trace' | 'log' | 'html' | 'json' | 'other';

export interface ArtifactEntry {
  id: string;
  name: string;
  type: ArtifactType;
  path: string;
  size: number;
  mimeType: string;
  runId?: string;
  createdAt: string;
}

export interface ArtifactFolder {
  name: string;
  path: string;
  children: (ArtifactFolder | ArtifactEntry)[];
  totalSize: number;
  fileCount: number;
}

// k6 trends ------------------------------------------------------------------

export interface K6MetricPoint {
  timestamp: string;
  rps: number;
  avgResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  errorRate: number;
  vus: number;
}

export interface K6RunSummary {
  runId: string;
  project: string;
  section?: string;
  performanceType?: PerformanceType;
  timestamp: string;
  duration: number;
  metrics: K6MetricPoint[];
  thresholds: { name: string; passed: boolean; value: string }[];
}

export interface K6TrendData {
  project: string;
  runs: K6RunSummary[];
}
