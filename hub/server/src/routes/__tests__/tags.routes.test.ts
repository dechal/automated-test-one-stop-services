import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the manifest-driven `/api/tags` endpoint.
 *
 *
 * Strategy: the route's FALLBACK path is now selected by the manifest's
 * `tags.strategy` (resolved via `getToolCapabilities`) instead of `tool === ...`
 * literals. We mock:
 *   - `../../services/exec.js` runChild — controls the reporter output (and
 *     whether a sentinel block is present) without spawning a real process,
 *   - `node:fs` — feeds the robot `[Tags]` file scan deterministically,
 *   - `../../services/manifest-registry.js` — controls the resolved strategy.
 *
 * The four cases prove: unknown tool / `tags:none` degrade to an empty,
 * non-throwing response with no fallback exec; `robot-files` scans files;
 * `playwright-list` re-runs and scrapes `@tags`.
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

interface RunChildResultLike {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  output: string;
}

/** Build a successful runChild result whose stdout carries the reporter output. */
function execOk(stdout: string): RunChildResultLike {
  return { ok: true, code: 0, stdout, stderr: '', output: stdout };
}

const mockRunChild = vi.fn<(cmd: string) => Promise<RunChildResultLike>>();
vi.mock('../../services/exec.js', () => ({
  runChild: (cmd: string) => mockRunChild(cmd),
}));

const mockExistsSync = vi.fn<(p: string) => boolean>();
const mockReaddirSync =
  vi.fn<(p: string, opts: unknown) => Array<{ name: string; isDirectory: () => boolean }>>();
const mockReadFileSync = vi.fn<(p: string, enc: string) => string>();
vi.mock('node:fs', () => ({
  default: {
    existsSync: (p: string) => mockExistsSync(p),
    readdirSync: (p: string, opts: unknown) => mockReaddirSync(p, opts),
    readFileSync: (p: string, enc: string) => mockReadFileSync(p, enc),
  },
}));

const mockGetToolCapabilities = vi.fn();
vi.mock('../../services/manifest-registry.js', () => ({
  getToolCapabilities: (...args: unknown[]) => mockGetToolCapabilities(...args),
  // The command-builder (buildTagsCommand / buildPlaywrightListCommand) sources
  // the task namespace from the manifest; a minimal stub keeps the emitted
  // command well-formed (execSync output is mocked, so the exact ns is moot).
  getToolManifest: vi.fn(async (id: string) => ({
    runner: { taskNamespace: id },
    projects: { root: 'projects', specsSubdir: 'automations/specs' },
  })),
}));

function capsWithStrategy(strategy: string) {
  return {
    run: { vars: [], headlessVar: null },
    reports: { resultGlob: '**/*.html', kind: null },
    tags: { strategy },
  };
}

// ─── Test setup ──────────────────────────────────────────────────────────────

describe('GET /api/tags (manifest-driven strategy dispatch)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Default: reporter emits no sentinel block (forces the fallback path).
    mockRunChild.mockResolvedValue(execOk(''));
    app = Fastify();
    const { tagRoutes } = await import('../tags.js');
    await app.register(tagRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('unknown tool resolves to tags:none — empty, non-throwing, no fallback exec', async () => {
    // Unknown / disabled tool → getToolCapabilities returns undefined → 'none'.
    mockGetToolCapabilities.mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'GET',
      url: '/api/tags?tool=cypress-mock&type=web&project=example',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.all).toEqual([]);
    expect(body.groups).toEqual([]);
    expect(body.details).toEqual({});
    // Only the primary tags command ran — no fallback re-exec for 'none'.
    expect(mockRunChild).toHaveBeenCalledTimes(1);
  });

  it('explicit tags:none degrades to an empty response without scanning', async () => {
    mockGetToolCapabilities.mockResolvedValue(capsWithStrategy('none'));

    const res = await app.inject({
      method: 'GET',
      url: '/api/tags?tool=cypress-mock&type=web&project=example',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().all).toEqual([]);
    expect(mockExistsSync).not.toHaveBeenCalled();
    expect(mockRunChild).toHaveBeenCalledTimes(1);
  });

  it('robot-files strategy scans .robot files for [Tags]', async () => {
    mockGetToolCapabilities.mockResolvedValue(capsWithStrategy('robot-files'));
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([{ name: 'suite.robot', isDirectory: () => false }]);
    mockReadFileSync.mockReturnValue(
      ['*** Test Cases ***', 'Scenario', '    [Tags]    smoke    regression', '    Log    hi'].join(
        '\n',
      ),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/tags?tool=robot-framework&type=web&project=example',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.all).toEqual(expect.arrayContaining(['smoke', 'regression']));
    // File scan ran; no playwright-style second exec.
    expect(mockReadFileSync).toHaveBeenCalled();
    expect(mockRunChild).toHaveBeenCalledTimes(1);
  });

  it('playwright-list strategy re-runs and scrapes @tags', async () => {
    mockGetToolCapabilities.mockResolvedValue(capsWithStrategy('playwright-list'));
    // 1st exec (tags cmd): no sentinel. 2nd exec (--list): tag annotations.
    mockRunChild
      .mockResolvedValueOnce(execOk(''))
      .mockResolvedValueOnce(execOk('@smoke @regression @critical'));

    const res = await app.inject({
      method: 'GET',
      url: '/api/tags?tool=playwright&type=web&project=example',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.all).toEqual(expect.arrayContaining(['@smoke', '@regression', '@critical']));
    // The re-run with `--list` is the second exec.
    expect(mockRunChild).toHaveBeenCalledTimes(2);
  });

  it('reporter sentinel: server classifies raw tests (case-ids never leak into Domain)', async () => {
    mockGetToolCapabilities.mockResolvedValue(capsWithStrategy('playwright-list'));

    // Raw per-test tag lists, as the reporter now emits them. `@ta`/`@TA_HAPPY`/
    // `@TA_LOOP` are multi-test domain tags; only `-C###` ids are case-ids.
    const tests = [
      {
        id: 'TA_DOMESTIC-C001',
        title: 'Domestic 1',
        tags: ['@critical', '@desktop', '@ta', '@TA_HAPPY', '@TA_DOMESTIC-C001'],
      },
      {
        id: 'TA_DOMESTIC-C002',
        title: 'Domestic 2',
        tags: ['@critical', '@desktop', '@ta', '@TA_HAPPY', '@TA_DOMESTIC-C002'],
      },
      {
        id: 'TA_INTER-C001',
        title: 'Inter 1',
        tags: ['@critical', '@ta', '@TA_LOOP', '@TA_INTER-C001'],
      },
    ];
    const payload = JSON.stringify({ tool: 'playwright', tests });
    mockRunChild.mockResolvedValue(
      execOk(`prelude noise\n__TAG_DATA_BEGIN__\n${payload}\n__TAG_DATA_END__\n`),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/tags?tool=playwright&type=web&project=sample-web',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      groups: { kind: string; label: string; tags: string[] }[];
      details: Record<string, { count: number }>;
    };
    const tagsOf = (kind: string) => body.groups.find((g) => g.kind === kind)?.tags ?? [];

    // Multi-test custom tags stay in Domain (count desc): @ta(3) before @TA_HAPPY(2).
    expect(tagsOf('domain')).toEqual(['@ta', '@TA_HAPPY']);
    // The single-test custom tag splits into its own group.
    expect(tagsOf('domain-single')).toEqual(['@TA_LOOP']);
    // Only real -C### ids land in Case ID.
    expect(tagsOf('case-id')).toEqual(['@TA_DOMESTIC-C001', '@TA_DOMESTIC-C002', '@TA_INTER-C001']);
    // The greedy-regex regression: these must never appear under Case ID.
    for (const tag of ['@ta', '@TA_HAPPY', '@TA_LOOP']) {
      expect(tagsOf('case-id')).not.toContain(tag);
    }
    expect(tagsOf('severity')).toEqual(['@critical']);
    expect(tagsOf('device')).toEqual(['@desktop']);
    expect(body.details['@ta']?.count).toBe(3);
    // Sentinel present in the primary exec — no fallback re-run.
    expect(mockRunChild).toHaveBeenCalledTimes(1);
  });
});
