import type { RunSummary } from './run-summary.js';
import type { SeverityBreakdown } from './severity-score.js';
import type { ToolId } from './tools.js';

export type RunMode = 'local' | 'docker';
export type HeadlessMode = 'headless' | 'headed';

/** How a run was launched. */
export type RunTrigger = 'manual' | 'schedule' | 'webhook';

export type PerformanceType =
  | 'TEST_PROTOCOL'
  | 'MINIMAL_LOAD'
  | 'LOAD'
  | 'STRESS'
  | 'ENDURANCE'
  | 'PEAK';

/** Request payload to start a test run. */
export interface RunRequest {
  tool: ToolId;
  type: string;
  project: string;
  mode: RunMode;
  /** Tag expression. For Playwright this is a regex; for Robot, a tag name. */
  tag?: string;
  headless?: HeadlessMode;
  extraArgs?: string;
  /** Disable Google Sheet usage logging. */
  noTrack?: boolean;
  /** Leave no trace: no history row, no report on disk, no test-case status sync. */
  silent?: boolean;
  /**
   * Delete the run's report directory once it has been used.
   *
   * Unlike {@link silent} this is a fully recorded run — history, live output and
   * the test-case status sync all happen — only the HTML report / traces / videos
   * are removed afterwards, so a repeating job (a daily bot) does not grow
   * `outputs/` without bound. Ignored when `silent` is set, which discards more.
   */
  discardReport?: boolean;
  // k6-only
  section?: string;
  performanceType?: PerformanceType;
}

export type RunStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'skipped'
  | 'failed'
  | 'cancelled'
  | 'error';

export interface RunRecord {
  id: string;
  request: RunRequest;
  command: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  /** Path to primary HTML report, if produced. */
  reportPath?: string;
  outputStamp?: string;
  /** Test-case counts parsed from the run output, when a summary was present. */
  summary?: RunSummary;
  /** How the run was launched. Persisted; defaults to 'manual' for legacy rows. */
  triggeredBy?: RunTrigger;
  /**
   * Per-severity passed/failed tally, parsed on demand from the Playwright
   * `results.json` when serving history. Transient (never persisted) — derived
   * from `reportPath`. Absent for non-Playwright tools or missing result files.
   */
  severity?: SeverityBreakdown;
}

/**
 * The failures of a finished run, reduced to what can select them again.
 *
 * Served by `GET /api/runs/:id/failed`, derived from the run's own `results.json`
 * (Playwright's `--last-failed` state file does not survive this workspace's
 * output cleanup). Case ids only — the client turns them into a grep expression
 * so expression shape has a single emitter.
 */
export interface FailedRunSelection {
  runId: string;
  request: RunRequest;
  /** Case-id tags of the failed tests. */
  caseIds: string[];
  /** Titles of failed tests with no case-id tag, so they cannot be re-selected. */
  unidentified: string[];
  total: number;
  failed: number;
}

/**
 * A saved run-form config (macro/shortcut): a name plus the captured
 * `RunRequest`. Clicking a bookmark reloads its `config` into the run form.
 */
export interface Bookmark {
  id: string;
  /** Saved-config display name. */
  name: string;
  config: RunRequest;
  createdAt: string;
}

/**
 * Snapshot of the run queue (`GET /api/queue`): what is executing now and what
 * is waiting. `queued` is in queue order, so the array index is the position.
 */
export interface QueueStatus {
  active: RunRecord[];
  queued: RunRecord[];
  activeCount: number;
  queueLength: number;
  /** Parallel-run cap currently configured in Settings. */
  maxConcurrency: number;
}

// WebSocket events -----------------------------------------------------------

export type WsServerEvent =
  | { kind: 'run-started'; runId: string; record: RunRecord }
  | { kind: 'run-stdout'; runId: string; chunk: string }
  | { kind: 'run-stderr'; runId: string; chunk: string }
  | { kind: 'run-finished'; runId: string; record: RunRecord }
  | {
      kind: 'schedule-finished';
      runId: string;
      scheduleId: string;
      /** Schedule name, or the schedule id when no name is set. */
      scheduleName: string;
      status: RunStatus;
      silent: boolean;
      /** Failure reason, when applicable. */
      message?: string;
    }
  | {
      kind: 'schedule-skipped';
      runId: string;
      scheduleId: string;
      scheduleName: string;
      message: string;
    }
  | {
      kind: 'run-report-missing';
      runId: string;
      label: string;
    };

export type WsClientEvent =
  | {
      kind: 'subscribe';
      runId: string;
      /**
       * When true, the server replays the run's buffered output (and a terminal
       * `run-finished` event if it has already completed) right after
       * subscribing. Used by a fresh run so a fast-finishing run still shows its
       * detail, even though it may complete before this subscribe lands. Omitted
       * (false) by the reconnect path, which already fetches `/output` over HTTP.
       */
      replay?: boolean;
    }
  | { kind: 'cancel'; runId: string };
