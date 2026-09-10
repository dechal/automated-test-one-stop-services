import fs from 'node:fs';
import path from 'node:path';
import type { K6RunSummary, K6TrendData } from '@hub/shared';
import { OUTPUTS_DIR } from '../config.js';
import { loadJson, saveJson } from './persistence.js';

const K6_TRENDS_FILE = 'k6-trends.json';

interface K6TrendsData {
  projects: Record<string, K6RunSummary[]>;
  lastUpdated: string;
}

function load(): K6TrendsData {
  return loadJson<K6TrendsData>(K6_TRENDS_FILE, { projects: {}, lastUpdated: '' });
}

function save(data: K6TrendsData): void {
  saveJson(K6_TRENDS_FILE, data);
}

function parseK6Summary(summaryPath: string, runTimestamp: string): Partial<K6RunSummary> | null {
  try {
    if (!fs.existsSync(summaryPath)) return null;
    const raw = fs.readFileSync(summaryPath, 'utf8');
    const data = JSON.parse(raw);

    const metrics = data.metrics ?? {};
    const httpReqDuration = metrics.http_req_duration ?? {};
    const httpReqs = metrics.http_reqs ?? {};
    const vus = metrics.vus ?? {};
    const httpReqFailed = metrics.http_req_failed ?? {};
    // k6's `http_req_failed.rate` is a FRACTION (0..1); the Hub renders it with a
    // literal `%`, so store it as a percentage here — the single conversion point.
    const errorRate = (httpReqFailed.values?.rate ?? 0) * 100;
    const durVals = httpReqDuration.values ?? {};
    const failedVals = httpReqFailed.values ?? {};
    const checks = metrics.checks?.values ?? {};
    const dataSent = metrics.data_sent?.values ?? {};
    const dataReceived = metrics.data_received?.values ?? {};
    const waiting = metrics.http_req_waiting?.values ?? {};
    const connecting = metrics.http_req_connecting?.values ?? {};
    const blocked = metrics.http_req_blocked?.values ?? {};

    // k6 stores thresholds PER METRIC (data.metrics.<name>.thresholds = { "<expr>":
    // { ok } }), not at the top level — so the previous top-level read always
    // produced an empty list. Flatten every metric's thresholds into one list.
    // Fall back to a top-level `data.thresholds` shape if a future export has one.
    const thresholds: { name: string; passed: boolean; value: string }[] = [];
    for (const [metricName, metric] of Object.entries(
      metrics as Record<string, { thresholds?: Record<string, { ok?: boolean }> }>,
    )) {
      for (const [expr, info] of Object.entries(metric?.thresholds ?? {})) {
        const passed = info?.ok ?? false;
        thresholds.push({
          name: `${metricName}: ${expr}`,
          passed,
          value: passed ? 'pass' : 'fail',
        });
      }
    }
    if (thresholds.length === 0 && data.thresholds) {
      for (const [name, info] of Object.entries(
        data.thresholds as Record<string, { ok?: boolean }>,
      )) {
        const passed = info?.ok ?? false;
        thresholds.push({ name, passed, value: passed ? 'pass' : 'fail' });
      }
    }

    // Real wall-clock test duration (seconds) from k6's `state.testRunDurationMs`
    // when present. The old `avg * count / 1000` was total request-seconds, which
    // inflates with concurrency and is not the test's elapsed time.
    const testRunDurationMs = (data.state?.testRunDurationMs ?? 0) as number;
    const duration = testRunDurationMs > 0 ? Math.round(testRunDurationMs / 1000) : 0;

    return {
      metrics: [
        {
          // Use the run's own timestamp (summary mtime), not scan time — otherwise
          // every run parsed in one refresh collapses to the same instant on the
          // trend chart.
          timestamp: runTimestamp,
          rps: httpReqs.values?.rate ?? 0,
          avgResponseTime: durVals.avg ?? 0,
          p95ResponseTime: durVals['p(95)'] ?? 0,
          p99ResponseTime: durVals['p(99)'] ?? 0,
          errorRate,
          vus: vus.values?.max ?? 0,
          medResponseTime: durVals.med ?? 0,
          p90ResponseTime: durVals['p(90)'] ?? 0,
          minResponseTime: durVals.min ?? 0,
          maxResponseTime: durVals.max ?? 0,
          totalRequests: httpReqs.values?.count ?? 0,
          failedRequests: failedVals.passes ?? 0,
          dataSent: dataSent.count ?? 0,
          dataReceived: dataReceived.count ?? 0,
          waitingTime: waiting.avg ?? 0,
          connectingTime: connecting.avg ?? 0,
          blockedTime: blocked.avg ?? 0,
          iterations: metrics.iterations?.values?.count ?? 0,
          checksPassed: checks.passes ?? 0,
          checksFailed: checks.fails ?? 0,
          checkRate: checks.rate ?? 0,
        },
      ],
      thresholds,
      duration,
    };
  } catch {
    return null;
  }
}

function walkForSummaries(dir: string, project: string, out: K6RunSummary[], depth = 0): void {
  if (depth > 8 || !fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walkForSummaries(fullPath, project, out, depth + 1);
    } else if (entry.name === 'summary.json') {
      const stat = fs.statSync(fullPath);
      const runTimestamp = stat.mtime.toISOString();
      const parsed = parseK6Summary(fullPath, runTimestamp);
      if (parsed) {
        out.push({
          runId: path.relative(path.join(OUTPUTS_DIR, 'k6', project), dir).replace(/\\/g, '/'),
          project,
          timestamp: runTimestamp,
          duration: parsed.duration ?? 0,
          metrics: parsed.metrics ?? [],
          thresholds: parsed.thresholds ?? [],
        });
      }
    }
  }
}

function scanK6Outputs(project: string): K6RunSummary[] {
  const projectDir = path.join(OUTPUTS_DIR, 'k6', project);
  if (!fs.existsSync(projectDir)) return [];

  const runs: K6RunSummary[] = [];
  walkForSummaries(projectDir, project, runs);

  return runs.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 50);
}

class K6TrendsService {
  getByProject(project: string): K6TrendData {
    const data = load();
    return { project, runs: data.projects[project] ?? [] };
  }

  getAll(): K6TrendData[] {
    const data = load();
    return Object.entries(data.projects).map(([project, runs]) => ({ project, runs }));
  }

  refresh(project?: string): K6TrendData[] {
    const data = load();

    if (project) {
      data.projects[project] = scanK6Outputs(project);
    } else {
      const k6Dir = path.join(OUTPUTS_DIR, 'k6');
      if (fs.existsSync(k6Dir)) {
        const projects = fs
          .readdirSync(k6Dir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
          .map((d) => d.name);

        for (const p of projects) {
          data.projects[p] = scanK6Outputs(p);
        }
      }
    }

    data.lastUpdated = new Date().toISOString();
    save(data);

    return Object.entries(data.projects).map(([p, runs]) => ({ project: p, runs }));
  }

  addRun(project: string, summary: K6RunSummary): void {
    const data = load();
    if (!data.projects[project]) data.projects[project] = [];
    data.projects[project].unshift(summary);
    if (data.projects[project].length > 50) {
      data.projects[project].length = 50;
    }
    data.lastUpdated = new Date().toISOString();
    save(data);
  }
}

export const k6TrendsService = new K6TrendsService();
