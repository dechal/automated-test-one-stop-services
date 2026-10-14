import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// reports.ts is now manifest-driven: the set of scannable `outputs/<tool>`
// dirs comes from the enabled manifests, and each tool's result file is matched
// via `resolveCapabilities(manifest).reports.resultGlob` (with a `**/*.html`
// fallback). Mock the config (OUTPUTS_DIR) + the manifest-registry so we can
// prove parity for the built-ins AND graceful degradation for an unknown tool.
interface MockManifest {
  id: string;
  projects: { typeAxis: boolean; fixedType: string | null };
  reports?: { resultGlob?: string; kind?: string };
}

const hoisted = vi.hoisted(() => ({
  outputsDir: '',
  manifests: [] as MockManifest[],
}));

vi.mock('../../config.js', async (orig) => {
  const actual = await orig<typeof import('../../config.js')>();
  return {
    ...actual,
    get OUTPUTS_DIR() {
      return hoisted.outputsDir;
    },
  };
});

// Mirror the real `resolveCapabilities` reports resolution: a missing
// `reports.resultGlob` degrades to the generic `**/*.html`.
const DEFAULT_REPORT_GLOB = '**/*.html';
vi.mock('../manifest-registry.js', () => ({
  getEnabledTools: async () => hoisted.manifests,
  getManifestModule: async () => ({
    resolveCapabilities: (m: MockManifest) => ({
      run: { vars: [], headlessVar: null },
      reports: { resultGlob: m.reports?.resultGlob ?? DEFAULT_REPORT_GLOB, kind: null },
      tags: { strategy: 'none' as const },
    }),
  }),
}));

const historyMock = vi.hoisted(() => ({ getAll: vi.fn(() => [] as unknown[]) }));
vi.mock('../history-store.js', () => ({ historyStore: { getAll: historyMock.getAll } }));

import type { RunRecord } from '@hub/shared';
import { invalidateReportsCache, listReports } from '../reports.js';

/** Build a full report path under outputs/ and write the result file. */
function seedReport(parts: string[]): void {
  const full = path.join(hoisted.outputsDir, ...parts);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, '<html></html>', 'utf8');
}

const PW = { id: 'playwright', projects: { typeAxis: true, fixedType: null } } as const;
const ROBOT = { id: 'robot-framework', projects: { typeAxis: true, fixedType: null } } as const;
const K6 = { id: 'k6', projects: { typeAxis: false, fixedType: 'performance' } } as const;

const builtIns: MockManifest[] = [
  { ...PW, reports: { resultGlob: '**/html-results/index.html', kind: 'html' } },
  { ...ROBOT, reports: { resultGlob: '**/report.html', kind: 'html' } },
  { ...K6, reports: { resultGlob: '**/summary.html', kind: 'html' } },
];

describe('reports (manifest-driven)', () => {
  beforeEach(() => {
    hoisted.outputsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reports-'));
    historyMock.getAll.mockReset();
    historyMock.getAll.mockReturnValue([]);
    invalidateReportsCache();
  });

  afterEach(() => {
    fs.rmSync(hoisted.outputsDir, { recursive: true, force: true });
    invalidateReportsCache();
  });

  it('(a) built-ins resolve their result files identically to the literals', async () => {
    hoisted.manifests = builtIns;

    // Playwright: index.html inside html-results/ (type axis: web)
    const pwBase = ['playwright', 'web', 'shop', 'success', '2024-01-01', '12-00-00'];
    seedReport([...pwBase, 'html-results', 'index.html']);
    // …but NOT a stray index.html outside html-results, NOR a trace index.html.
    seedReport([...pwBase, 'other', 'index.html']);
    seedReport([...pwBase, 'trace', 'index.html']);

    // Robot: report.html (NOT log.html) (type axis: api)
    const rbBase = ['robot-framework', 'api', 'svc', 'error', '2024-02-02', '13-30-00'];
    seedReport([...rbBase, 'report.html']);
    seedReport([...rbBase, 'log.html']);

    // k6: summary.html, flat layout (no type axis), type = performance.
    const k6Base = ['k6', 'load', 'success', '2024-03-03', '14-15-00'];
    seedReport([...k6Base, 'summary.html']);

    const all = await listReports();
    const key = (e: { tool: string; type: string; project: string; status: string }) =>
      `${e.tool}/${e.type}/${e.project}/${e.status}`;
    const keys = all.map(key).sort();

    expect(keys).toEqual([
      'k6/performance/load/success',
      'playwright/web/shop/success',
      'robot-framework/api/svc/error',
    ]);

    // The Playwright entry resolves exactly the html-results/index.html file.
    const pw = all.find((e) => e.tool === 'playwright');
    expect(pw?.reportPath.replace(/\\/g, '/')).toContain('/html-results/index.html');
    // The timestamp is now an ISO-8601 instant (aligned to history's
    // `startedAt`), reconstructed from the dir's LOCAL wall-clock segments.
    // Build the expectation the same way so the assertion is timezone-safe.
    expect(pw?.timestamp).toBe(new Date(2024, 0, 1, 12, 0, 0).toISOString());
  });

  it('(b) an unknown tool with no reports block lists any *.html (degrade, not break)', async () => {
    hoisted.manifests = [
      { id: 'cypress', projects: { typeAxis: true, fixedType: null } }, // no `reports`
    ];
    const base = ['cypress', 'e2e', 'app', 'success', '2024-04-04', '15-45-00'];
    seedReport([...base, 'results.html']);
    seedReport([...base, 'nested', 'mochawesome.html']);

    const all = await listReports();
    expect(all).toHaveLength(2);
    expect(all.every((e) => e.tool === 'cypress' && e.type === 'e2e' && e.project === 'app')).toBe(
      true,
    );
  });

  it('(c) a disabled/unknown outputs dir is skipped', async () => {
    hoisted.manifests = [...builtIns]; // cypress is NOT enabled
    // Seed a built-in (should appear) and a non-enabled tool dir (should be ignored).
    seedReport(['k6', 'load', 'success', '2024-03-03', '14-15-00', 'summary.html']);
    seedReport(['cypress', 'e2e', 'app', 'success', '2024-04-04', '15-45-00', 'results.html']);

    const all = await listReports();
    expect(all.map((e) => e.tool)).toEqual(['k6']);
  });

  it('copies envProfileName onto the matched entry alongside environment', async () => {
    hoisted.manifests = builtIns;
    const base = ['playwright', 'web', 'shop', 'success', '2024-05-05', '09-00-00'];
    seedReport([...base, 'html-results', 'index.html']);

    const run: RunRecord = {
      id: 'run-1',
      request: { tool: 'playwright', type: 'web', project: 'shop', mode: 'local' },
      command: 'task test',
      status: 'passed',
      startedAt: new Date(2024, 4, 5, 9, 0, 0).toISOString(),
      endedAt: new Date(2024, 4, 5, 9, 0, 30).toISOString(),
      outputStamp: '2024-05-05/09-00-00',
      environment: 'prod',
      envProfileName: 'Main Prod',
    };
    historyMock.getAll.mockReturnValue([run]);

    const all = await listReports();
    const entry = all.find((e) => e.tool === 'playwright' && e.project === 'shop');
    expect(entry?.environment).toBe('prod');
    expect(entry?.envProfileName).toBe('Main Prod');
  });

  it('filters by tool/status are applied to the cached entries', async () => {
    hoisted.manifests = builtIns;
    seedReport(['k6', 'load', 'success', '2024-03-03', '14-15-00', 'summary.html']);
    seedReport(['robot-framework', 'api', 'svc', 'error', '2024-02-02', '13-30-00', 'report.html']);

    expect(await listReports({ tool: 'k6' })).toHaveLength(1);
    expect(await listReports({ status: 'error' })).toHaveLength(1);
    expect(await listReports({ tool: 'k6', status: 'error' })).toHaveLength(0);
  });
});
