import fsp from 'node:fs/promises';
import path from 'node:path';
import { type RunRecord, runDirFromReportPath, type WsServerEvent } from '@hub/shared';
import { OUTPUTS_DIR } from '../config.js';
import { isUnder } from './path-guard.js';
import { invalidateReportsCache } from './reports.js';
import { runner } from './runner.js';
import { resolveReportPath, syncDocsForRun } from './testcase-status-sync.js';

/**
 * Delays before each attempt to locate the finished run's report. The report
 * directory is promoted by the task itself, and on Windows that move is retried
 * around file locks, so it can land slightly after the process exits.
 */
const REPORT_WAIT_STEPS_MS = [0, 2000, 5000];

/**
 * The run's own report directory — `<…>/<date>/<time>/`, the parent of
 * `html-results/index.html`. This is the unit a discard removes: it holds the
 * HTML report, `results.json`, traces, videos and screenshots for exactly one run.
 */
export function reportDirFor(reportPath: string): string {
  return path.normalize(runDirFromReportPath(reportPath));
}

/**
 * Delete one run's report directory. Guarded to `outputs/` so a malformed report
 * path can never remove anything else, and best-effort: a locked file leaves the
 * directory in place rather than failing the run.
 */
export async function discardReportDir(reportPath: string, outputStamp?: string): Promise<boolean> {
  const dir = reportDirFor(reportPath);
  if (!isUnder(OUTPUTS_DIR, dir)) return false;
  if (outputStamp !== undefined && !dir.replace(/\\/g, '/').endsWith(`/${outputStamp}`)) {
    return false;
  }
  try {
    await fsp.rm(dir, { recursive: true, force: true });
    // The reports listing caches its walk; drop it so the deleted run stops
    // appearing in Reports / Dashboard until the next natural refresh.
    invalidateReportsCache();
    return true;
  } catch {
    return false;
  }
}

/** Locate the run's report, polling while the task finishes promoting it. */
async function waitForReport(record: RunRecord): Promise<string | undefined> {
  for (const [attempt, delayMs] of REPORT_WAIT_STEPS_MS.entries()) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      // The reports listing is cached for 10s; without dropping it here a retry
      // would keep reading the same pre-promotion snapshot.
      invalidateReportsCache();
    }
    const reportPath = await resolveReportPath(record);
    if (reportPath) return reportPath;
  }
  return undefined;
}

/**
 * Everything that happens after a run finishes, in the one order that works:
 * read the report first, then delete it.
 *
 * - `silent` — leaves no trace: no status sync, and the report the tool wrote is
 *   removed. (The runner already skips history for it.)
 * - `discardReport` — a fully recorded run whose bulky report is dropped once the
 *   status sync has read it. Meant for a repeating job that would otherwise grow
 *   `outputs/` without bound.
 * - otherwise — sync only; the report is kept.
 */
export async function runPostRunSteps(record: RunRecord): Promise<void> {
  const silent = record.request.silent === true;
  const discard = silent || record.request.discardReport === true;
  // A kept, non-silent run still needs the report located for its status sync,
  // so every path starts here.
  const reportPath = await waitForReport(record);

  if (!silent && reportPath === undefined && record.status !== 'cancelled') {
    runner.emitEvent({
      kind: 'run-report-missing',
      runId: record.id,
      label: `${record.request.tool}/${record.request.project}`,
    });
  }

  if (!silent && reportPath) await syncDocsForRun(record, reportPath);
  if (discard && reportPath) await discardReportDir(reportPath, record.outputStamp);
}

let started = false;

/**
 * Subscribe to run completion so results land in the test-case overlays, and a
 * discarded run's report is cleaned up, without the user pressing anything.
 * Idempotent.
 */
export function startPostRunPipeline(): void {
  if (started) return;
  started = true;
  runner.on('event', (event: WsServerEvent) => {
    if (event.kind !== 'run-finished') return;
    void runPostRunSteps(event.record).catch(() => {
      // Advisory: neither a doc write nor a cleanup may fail a run.
    });
  });
}
