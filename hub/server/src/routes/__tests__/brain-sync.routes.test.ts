import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface RunChildResultLike {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  output: string;
  timedOut?: boolean;
}

const mockRunChild =
  vi.fn<(cmd: string, args: string[], opts: unknown) => Promise<RunChildResultLike>>();
vi.mock('../../services/exec.js', () => ({
  runChild: (cmd: string, args: string[], opts: unknown) => mockRunChild(cmd, args, opts),
}));
vi.mock('../../config.js', () => ({ WORKSPACE_ROOT: '/ws' }));

function reply(stdout: string, code = 0): RunChildResultLike {
  return { ok: code === 0, code, stdout, stderr: '', output: stdout };
}

describe('POST /api/brain/sync', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { brainSyncRoutes } = await import('../brain-sync.js');
    app = Fastify();
    await app.register(brainSyncRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns per-project results even when the script exits non-zero (diverged)', async () => {
    const results = [{ project: 'iia', status: 'diverged', message: 'skipped' }];
    mockRunChild.mockResolvedValue(reply(JSON.stringify(results), 1));
    const res = await app.inject({ method: 'POST', url: '/api/brain/sync', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results });
  });

  it('passes a single project slug to the script', async () => {
    mockRunChild.mockResolvedValue(reply('[]'));
    await app.inject({ method: 'POST', url: '/api/brain/sync', payload: { project: 'iia' } });
    expect(mockRunChild.mock.calls[0]?.[1].slice(1)).toEqual(['--json', 'iia']);
  });

  it('rejects a slug with path characters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/brain/sync',
      payload: { project: '../x' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockRunChild).not.toHaveBeenCalled();
  });

  it('answers 500 when the script prints no JSON', async () => {
    mockRunChild.mockResolvedValue(reply('boom', 2));
    const res = await app.inject({ method: 'POST', url: '/api/brain/sync', payload: {} });
    expect(res.statusCode).toBe(500);
  });
});
