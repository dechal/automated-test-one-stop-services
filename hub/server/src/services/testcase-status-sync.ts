import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RunRecord, TestCaseRunResult, TestCaseSheet } from '@hub/shared';
import { SCRIPTS_DIR, TOOLS_DIR } from '../config.js';
import { getHubUser } from './hub-user.js';
import { isUnder } from './path-guard.js';
import { reportEntryByRun } from './reports.js';
import { parseRunOutcomes } from './run-compare.js';
import { listTestCaseDocs, readOverlay, readTestCaseGrid } from './testcases.js';

interface RunSyncModule {
  syncRunToDoc: (
    docPath: string,
    sheets: TestCaseSheet[],
    resultByCaseId: Record<string, TestCaseRunResult>,
    options: {
      author?: { id: string; name: string };
      runAt?: string;
      editors: Record<string, string>;
    },
  ) => { matched: number; total: number };
}

function loadRunSync(): Promise<RunSyncModule> {
  const url = pathToFileURL(path.join(SCRIPTS_DIR, 'lib', 'testcase-run-sync.mjs')).href;
  return import(url) as Promise<RunSyncModule>;
}

/** Per-doc outcome of one sync pass. */
export interface DocSyncResult {
  /** Absolute path of the source doc whose overlay was updated. */
  docPath: string;
  matched: number;
  total: number;
}

/** Project directory for a run/doc target, using the tools/ layout the Hub scans. */
export function projectDirFor(tool: string, type: string, project: string): string {
  return path.join(TOOLS_DIR, tool, 'projects', type, project);
}

/**
 * Map every test-case id a run reported to its outcome.
 *
 * A run outcome contributes TWO kinds of id: the spec's own id (the
 * `"<caseId>: …"` title prefix) and every `TC-*` cover tag it declares — an E2E
 * spec usually covers several doc cases, so cover tags are what make the
 * doc↔spec link work (brain LESS-066). Returns an empty map when the run has no
 * parseable `results.json`.
 */
export function resultMapFromReport(
  reportPath: string | undefined,
): Record<string, TestCaseRunResult> {
  const byCaseId: Record<string, TestCaseRunResult> = {};
  for (const outcome of parseRunOutcomes(reportPath) ?? []) {
    const ids = new Set<string>();
    const ownId = outcome.title.split(':')[0]?.trim();
    if (ownId) ids.add(ownId);
    for (const tag of outcome.tags ?? []) if (tag.startsWith('TC-')) ids.add(tag);
    for (const id of ids) {
      byCaseId[id] = {
        status: outcome.status === 'passed' ? 'passed' : 'failed',
        ...(outcome.error ? { error: outcome.error } : {}),
      };
    }
  }
  return byCaseId;
}

/**
 * Resolve the report a finished run produced. `RunRecord.reportPath` is declared
 * but never written by the runner, so it is resolved here from the reports
 * listing (tool/type/project + nearest-time match). Falls back to the record's
 * own `reportPath` when a caller has already set one.
 */
export async function resolveReportPath(record: RunRecord): Promise<string | undefined> {
  if (record.reportPath) return record.reportPath;
  const matched = await reportEntryByRun([record]);
  return matched.get(record.id)?.reportPath;
}

/**
 * Map a run's results onto every test-case doc of its project, writing only the
 * `.edited.json` overlays. Docs whose ids do not appear in the run are left
 * untouched (`matched: 0`) — that is a coverage gap, not a failure.
 */
export async function syncDocsForRun(
  record: RunRecord,
  reportPath?: string,
): Promise<{ results: DocSyncResult[]; reportPath?: string; runAt: string | null }> {
  const resolved = reportPath ?? (await resolveReportPath(record));
  const runAt = record.endedAt ?? record.startedAt ?? null;
  const resultByCaseId = resultMapFromReport(resolved);
  if (Object.keys(resultByCaseId).length === 0) {
    return { results: [], ...(resolved ? { reportPath: resolved } : {}), runAt };
  }
  const { tool, type, project } = record.request;
  const projectDir = projectDirFor(tool, type, project);
  if (!isUnder(TOOLS_DIR, projectDir)) return { results: [], runAt };
  // Same author as the manual sync, so "Edited By" never depends on whether the
  // mapping happened automatically or by button.
  const user = getHubUser();
  const author = user ? { id: user.id, name: user.name } : undefined;
  const { syncRunToDoc } = await loadRunSync();
  const results: DocSyncResult[] = [];
  for (const doc of listTestCaseDocs(projectDir)) {
    const grid = await readTestCaseGrid(doc.path);
    if (!grid) continue;
    const applied = syncRunToDoc(doc.path, grid.sheets, resultByCaseId, {
      ...(author ? { author } : {}),
      ...(runAt ? { runAt } : {}),
      editors: readOverlay(doc.path)?.editors ?? {},
    });
    results.push({ docPath: doc.path, matched: applied.matched, total: applied.total });
  }
  return { results, ...(resolved ? { reportPath: resolved } : {}), runAt };
}

// Run completion is wired in `post-run.ts`, which owns the order of the
// after-run steps: locate the report, sync from it, and only then discard it.
