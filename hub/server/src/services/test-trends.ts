import type { TestStatus, TestTrend, TestTrendReport, ToolId, TrendPoint } from '@hub/shared';
import { classifyTag } from '@hub/shared';
import { listReports } from './reports.js';
import { parseRunOutcomes } from './run-compare.js';
import { listAllProjects } from './scanner.js';

const MIN_RUNS_FOR_FLAKY = 3;
const FLAKY_THRESHOLD = 20;
const TITLE_CASE_ID_RE = /^([A-Z0-9][A-Z0-9_-]*)\s*:/;

/** Case id for a spec: a real case-id tag wins, else the `<ID>:` title prefix. */
function caseIdOf(title: string, tags: string[]): string | undefined {
  const tagged = tags.find((tag) => classifyTag(tag) === 'case-id');
  if (tagged) return tagged.replace(/^@/, '');
  return TITLE_CASE_ID_RE.exec(title)?.[1];
}

/** Percentage of adjacent status pairs that differ; <2 points scores 0. */
function flakinessFromPoints(points: TrendPoint[]): { flips: number; score: number } {
  if (points.length < 2) return { flips: 0, score: 0 };
  let flips = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i]?.status !== points[i - 1]?.status) flips++;
  }
  return { flips, score: Math.round((flips / (points.length - 1)) * 100) };
}

interface Acc {
  key: string;
  title: string;
  file?: string;
  caseId?: string;
  points: TrendPoint[];
}

/**
 * Per-test trend for one Playwright project, aggregated across the retained
 * runs on disk. Each report's `results.json` is parsed via `parseRunOutcomes`
 * and bucketed by the stable `spec.id` (`RunOutcome.key`), so a test's outcome
 * is tracked across runs even as its title changes. Playwright-only: other
 * tools emit no `results.json`, so their reports contribute nothing and the
 * report comes back `unavailable`.
 */
export async function buildTestTrends(
  tool: ToolId,
  type: string,
  project: string,
): Promise<TestTrendReport> {
  const entries = (await listReports({ tool, type, project })).sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );

  const byKey = new Map<string, Acc>();
  let runsAnalyzed = 0;

  for (const entry of entries) {
    const outcomes = parseRunOutcomes(entry.reportPath);
    if (!outcomes || outcomes.length === 0) continue;
    runsAnalyzed++;
    for (const o of outcomes) {
      let acc = byKey.get(o.key);
      if (!acc) {
        acc = {
          key: o.key,
          title: o.title,
          file: o.file,
          caseId: caseIdOf(o.title, o.tags ?? []),
          points: [],
        };
        byKey.set(o.key, acc);
      } else {
        // Newest title/file win, so a renamed spec reads by its current name.
        acc.title = o.title;
        if (o.file) acc.file = o.file;
      }
      acc.points.push({ runId: entry.id, at: entry.timestamp, status: o.status });
    }
  }

  const tests: TestTrend[] = [];
  for (const acc of byKey.values()) {
    const totalRuns = acc.points.length;
    const passes = acc.points.filter((p) => p.status === 'passed').length;
    const failures = totalRuns - passes;
    const { flips, score } = flakinessFromPoints(acc.points);
    const last = acc.points[totalRuns - 1] as TrendPoint;
    const lastStatus: TestStatus = last.status;
    tests.push({
      key: acc.key,
      title: acc.title,
      ...(acc.file ? { file: acc.file } : {}),
      ...(acc.caseId ? { caseId: acc.caseId } : {}),
      totalRuns,
      passes,
      failures,
      passRate: totalRuns > 0 ? Math.round((passes / totalRuns) * 100) : 0,
      flips,
      flakinessScore: score,
      isFlaky: totalRuns >= MIN_RUNS_FOR_FLAKY && score >= FLAKY_THRESHOLD,
      points: acc.points,
      lastStatus,
      lastSeen: last.at,
    });
  }

  // Flaky first (worst score), then lowest pass rate, then title.
  tests.sort(
    (a, b) =>
      Number(b.isFlaky) - Number(a.isFlaky) ||
      b.flakinessScore - a.flakinessScore ||
      a.passRate - b.passRate ||
      a.title.localeCompare(b.title),
  );

  return {
    generatedAt: new Date().toISOString(),
    tool,
    type,
    project,
    runsAnalyzed,
    totalTests: tests.length,
    flakyCount: tests.filter((t) => t.isFlaky).length,
    tests,
    unavailable: runsAnalyzed === 0,
  };
}

/**
 * Per-test trends for every project that has any, across all enabled tools —
 * so the client can show the whole map grouped by tool/type/project without
 * one request per project. Only Playwright produces the `results.json` the
 * trend depends on, so a project with no parseable run is dropped from the
 * result (its `unavailable` report carries nothing to show). Reuses the
 * 10s-cached report listing, so the N per-project passes are cheap.
 */
export async function buildAllTestTrends(): Promise<TestTrendReport[]> {
  const projects = await listAllProjects();
  const out: TestTrendReport[] = [];
  for (const p of projects) {
    const report = await buildTestTrends(p.tool, p.type, p.name);
    if (!report.unavailable && report.totalTests > 0) out.push(report);
  }
  return out;
}
