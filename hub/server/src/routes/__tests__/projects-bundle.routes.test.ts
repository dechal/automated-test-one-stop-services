import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_ROOT } from '../../config.js';

interface BundleCallOptions {
  readonly withEnv?: boolean;
  readonly zip?: boolean;
  readonly ci?: string;
  readonly onStage?: (stage: string) => void;
}

const STAGES = ['validate', 'copy-project', 'zip'];
const OUTSIDE = path.resolve(WORKSPACE_ROOT, '..', 'bundle-route-test-out');

const mockGetEnabledTools = vi.fn();
vi.mock('../../services/manifest-registry.js', () => ({
  getEnabledTools: () => mockGetEnabledTools(),
}));

const mockExportBundle = vi.fn<(opts: BundleCallOptions) => Promise<unknown>>();
const mockExportStandalone = vi.fn<(opts: BundleCallOptions) => Promise<unknown>>(async () => ({
  result: { tool: 'k6' },
  resynced: false,
  regeneratedFiles: [],
}));
const mockIsBundleSupported = vi.fn<(tool: string) => boolean>();
vi.mock('../../services/export-module.js', () => ({
  getExportModule: async () => ({
    BUNDLE_STAGES: STAGES,
    CI_CHOICES: ['none', 'gitlab', 'github', 'both'],
    isCiSupported: (tool: string, kind: string) => tool === 'k6' && kind === 'bundle',
    isBundleSupported: (tool: string) => mockIsBundleSupported(tool),
    isStandaloneSupported: (tool: string) => tool === 'k6',
    exportProjectStandalone: (opts: BundleCallOptions) => mockExportStandalone(opts),
    isSafeIdent: (value: string) => /^[a-zA-Z0-9._/-]+$/.test(value),
    exportProjectBundle: (opts: BundleCallOptions) => mockExportBundle(opts),
  }),
}));

vi.mock('../../services/exec.js', () => ({ runChild: vi.fn() }));
vi.mock('../../services/scanner.js', () => ({
  invalidateProjectCache: vi.fn(),
  listAllProjects: vi.fn(async () => []),
  listProjects: vi.fn(async () => ['demo']),
  listSections: vi.fn(async () => []),
  listTypes: vi.fn(async () => []),
}));
vi.mock('../../services/project-cleanup.js', () => ({
  removeProjectCascade: vi.fn(async () => ({})),
}));
vi.mock('../../services/workspace-sync.js', () => ({
  withResync: (fn: () => unknown) => fn(),
}));

const DONE = {
  result: { tool: 'k6', type: 'performance', project: 'demo', kind: 'bundle' },
  resynced: false,
  regeneratedFiles: [],
};

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('POST /api/projects/bundle', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetEnabledTools.mockResolvedValue([{ id: 'k6' }, { id: 'appium' }]);
    mockIsBundleSupported.mockImplementation((tool) => tool === 'k6');
    mockExportBundle.mockResolvedValue(DONE);
    app = Fastify();
    const { projectRoutes } = await import('../projects.js');
    await app.register(projectRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  function post(payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/api/projects/bundle', payload });
  }

  const valid = { tool: 'k6', type: 'performance', project: 'demo', targetDir: OUTSIDE };

  it('400 BAD_REQUEST when a required field is missing', async () => {
    const res = await post({ tool: 'k6', type: 'performance', project: 'demo' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('404 TOOL_NOT_FOUND for an unknown tool', async () => {
    const res = await post({ ...valid, tool: 'nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('TOOL_NOT_FOUND');
  });

  it('422 TOOL_NOT_SUPPORTED when the tool has no bundle strategy', async () => {
    const res = await post({ ...valid, tool: 'appium' });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('TOOL_NOT_SUPPORTED');
  });

  it('400 INVALID_IDENT for an unsafe project', async () => {
    const res = await post({ ...valid, project: 'demo;rm' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_IDENT');
  });

  it('400 BAD_REQUEST when withEnv is not a boolean', async () => {
    const res = await post({ ...valid, withEnv: 'yes' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('400 INVALID_CI for an unknown provider', async () => {
    const res = await post({ ...valid, ci: 'jenkins' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_CI');
    expect(mockExportBundle).not.toHaveBeenCalled();
  });
  it('passes a valid ci provider to the exporter', async () => {
    const res = await post({ ...valid, ci: 'both' });
    expect(res.statusCode).toBe(202);
    await flush();
    expect(mockExportBundle.mock.calls[0]?.[0].ci).toBe('both');
  });
  it('400 INVALID_TARGET for a relative targetDir', async () => {
    const res = await post({ ...valid, targetDir: 'relative/out' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_TARGET');
  });

  it('400 INVALID_TARGET for a targetDir inside the workspace', async () => {
    const res = await post({ ...valid, targetDir: path.join(WORKSPACE_ROOT, '.cache', 'out') });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_TARGET');
    expect(mockExportBundle).not.toHaveBeenCalled();
  });

  it('404 PROJECT_NOT_FOUND for a missing project', async () => {
    const res = await post({ ...valid, project: 'missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('PROJECT_NOT_FOUND');
  });

  it('202 with a jobId, then the job reports done', async () => {
    mockExportBundle.mockImplementation(async (opts) => {
      opts.onStage?.('copy-project');
      return DONE;
    });
    const res = await post({ ...valid, withEnv: true });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    expect(typeof jobId).toBe('string');
    await flush();
    expect(mockExportBundle).toHaveBeenCalledWith(
      expect.objectContaining({ withEnv: true, zip: false, targetDir: OUTSIDE }),
    );
    const job = await app.inject({ method: 'GET', url: `/api/projects/bundle/${jobId}` });
    expect(job.statusCode).toBe(200);
    expect(job.json()).toMatchObject({
      status: 'done',
      stage: 'copy-project',
      stageIndex: 2,
      stageCount: 3,
      result: DONE,
    });
  });

  it('409 EXPORT_BUSY while another job runs', async () => {
    mockExportBundle.mockImplementation(() => new Promise(() => {}));
    expect((await post(valid)).statusCode).toBe(202);
    const res = await post(valid);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('EXPORT_BUSY');
  });

  it('GET 404 JOB_NOT_FOUND for an unknown job', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/bundle/unknown' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('JOB_NOT_FOUND');
  });
});

describe('POST /api/projects/standalone ci', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetEnabledTools.mockResolvedValue([{ id: 'k6' }]);
    app = Fastify();
    const { projectRoutes } = await import('../projects.js');
    await app.register(projectRoutes);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });
  function postStandalone(ci: unknown) {
    return app.inject({
      method: 'POST',
      url: '/api/projects/standalone',
      payload: { tool: 'k6', type: 'performance', project: 'demo', targetDir: OUTSIDE, ci },
    });
  }
  it('400 INVALID_CI for a non-string or unknown provider', async () => {
    for (const ci of [true, 'jenkins']) {
      const res = await postStandalone(ci);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_CI');
    }
    expect(mockExportStandalone).not.toHaveBeenCalled();
  });
  it('422 CI_NOT_SUPPORTED when the tool has no standalone CI', async () => {
    const res = await postStandalone('gitlab');
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('CI_NOT_SUPPORTED');
  });
  it('passes ci none through and returns the export', async () => {
    const res = await postStandalone('none');
    expect(res.statusCode).toBe(200);
    expect(mockExportStandalone.mock.calls[0]?.[0].ci).toBe('none');
  });
});
