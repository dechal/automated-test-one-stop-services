import path from 'node:path';
import {
  COVERAGE_UNMAPPED,
  type CoverageCase,
  type CoverageGroup,
  type CoverageOutcome,
  type CoverageReport,
  type ToolId,
} from '@hub/shared';
import { TOOLS_DIR } from '../config.js';
import { isUnder } from './path-guard.js';
import { listReports } from './reports.js';
import { listAllProjects } from './scanner.js';
import { resultMapFromReport } from './testcase-status-sync.js';
import { listTestCaseDocs, readTestCaseGrid } from './testcases.js';

const ID_HEADER = 'Test Case ID';
const SCENARIO_HEADER = 'Test Scenario';
const REQ_HEADER = 'Requirement Ref ID';

function headerIndex(header: string[], name: string): number {
  return header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
}

/** `<tool>/projects/<type>/<project>` — the same layout the scanner uses. */
function projectDirFor(tool: string, type: string, project: string): string {
  return path.join(TOOLS_DIR, tool, 'projects', type, project);
}

/**
 * Split a `Requirement Ref ID` cell into requirement tokens. Empty or `N/A`
 * yields none, so those rows fall into the `__unmapped__` group. Comma /
 * semicolon / whitespace separated (a row may cover several requirements).
 */
function requirementTokens(cell: string): string[] {
  const trimmed = cell.trim();
  if (!trimmed || trimmed.toLowerCase() === 'n/a') return [];
  return trimmed
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function emptyGroup(requirement: string): CoverageGroup {
  return { requirement, cases: [], total: 0, passed: 0, failed: 0, notRun: 0 };
}

function tallyInto(group: CoverageGroup, c: CoverageCase): void {
  group.cases.push(c);
  group.total++;
  if (c.outcome === 'passed') group.passed++;
  else if (c.outcome === 'failed') group.failed++;
  else group.notRun++;
}

/**
 * Coverage matrix for one project: every documented test case joined to the
 * latest run's per-case outcome, grouped best-effort by `Requirement Ref ID`.
 * Reuses the same doc reader and result-mapping the status-sync uses, so a
 * case's outcome here matches what the doc's own `Status` sync would write.
 * Playwright-oriented: the join depends on a run's `results.json`, so a project
 * with no parseable latest run comes back `hasRun: false` with every case
 * `not-run`.
 */
export async function buildCoverage(
  tool: ToolId,
  type: string,
  project: string,
): Promise<CoverageReport> {
  const projectDir = projectDirFor(tool, type, project);
  const docs = isUnder(TOOLS_DIR, projectDir) ? listTestCaseDocs(projectDir) : [];

  // Latest report for this project → its per-case outcome map.
  const reports = (await listReports({ tool, type, project })).sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp),
  );
  const latest = reports[0];
  const resultByCaseId = latest ? resultMapFromReport(latest.reportPath) : {};
  const hasRun = Object.keys(resultByCaseId).length > 0;

  const groups = new Map<string, CoverageGroup>();
  let totalCases = 0;
  let passed = 0;
  let failed = 0;
  let notRun = 0;
  let covered = 0;

  for (const doc of docs) {
    const grid = await readTestCaseGrid(doc.path);
    if (!grid) continue;
    for (const sheet of grid.sheets) {
      const header = sheet.rows[0] ?? [];
      const idIdx = headerIndex(header, ID_HEADER);
      if (idIdx < 0) continue;
      const scenarioIdx = headerIndex(header, SCENARIO_HEADER);
      const reqIdx = headerIndex(header, REQ_HEADER);
      for (let r = 1; r < sheet.rows.length; r++) {
        const row = sheet.rows[r];
        const caseId = (row?.[idIdx] ?? '').trim();
        if (!caseId) continue;
        const result = resultByCaseId[caseId];
        const outcome: CoverageOutcome = result
          ? result.status === 'passed'
            ? 'passed'
            : 'failed'
          : 'not-run';
        const reqCell = reqIdx >= 0 ? (row?.[reqIdx] ?? '') : '';
        const covCase: CoverageCase = {
          caseId,
          scenario: scenarioIdx >= 0 ? (row?.[scenarioIdx] ?? '').trim() : '',
          requirementRef: reqCell.trim(),
          doc: doc.name,
          outcome,
        };

        totalCases++;
        if (outcome === 'passed') passed++;
        else if (outcome === 'failed') failed++;
        else notRun++;
        if (result) covered++;

        const tokens = requirementTokens(reqCell);
        const keys = tokens.length > 0 ? tokens : [COVERAGE_UNMAPPED];
        for (const key of keys) {
          let g = groups.get(key);
          if (!g) {
            g = emptyGroup(key);
            groups.set(key, g);
          }
          tallyInto(g, covCase);
        }
      }
    }
  }

  // Named requirements first (natural sort), the unmapped bucket last.
  const sortedGroups = [...groups.values()].sort((a, b) => {
    if (a.requirement === COVERAGE_UNMAPPED) return 1;
    if (b.requirement === COVERAGE_UNMAPPED) return -1;
    return a.requirement.localeCompare(b.requirement, 'en', { numeric: true });
  });

  return {
    generatedAt: new Date().toISOString(),
    tool,
    type,
    project,
    totalCases,
    passed,
    failed,
    notRun,
    covered,
    groups: sortedGroups,
    hasRun,
  };
}

/**
 * Coverage for every project that has documented test cases, across all enabled
 * tools — so the client can show the whole map grouped by tool/type/project
 * without one request per project. A project with no docs (`totalCases === 0`)
 * is dropped.
 */
export async function buildAllCoverage(): Promise<CoverageReport[]> {
  const projects = await listAllProjects();
  const out: CoverageReport[] = [];
  for (const p of projects) {
    const report = await buildCoverage(p.tool, p.type, p.name);
    if (report.totalCases > 0) out.push(report);
  }
  return out;
}
