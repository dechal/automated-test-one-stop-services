import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route tests for the d1j cache + timeout on GET /api/git/status:
 *   - concurrent callers share ONE sweep (in-flight promise)
 *   - a repeat call inside the TTL returns the cache without re-spawning git
 *   - a successful pull clears the cache so the next status re-sweeps
 *   - a hung `ls-remote` (timeout) yields `error: 'timeout'`, others still return
 *
 * Side-effecting services are mocked so no real git/process runs.
 */

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

vi.mock('../../services/scanner.js', () => ({
  listAllProjects: vi.fn(async () => []),
}));

vi.mock('../../services/hub-rebuild.js', () => ({
  rebuildHub: vi.fn(async () => ({ ok: true })),
  scheduleHubRestart: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  WORKSPACE_ROOT: '/ws',
}));

function execOk(output = ''): RunChildResultLike {
  return { ok: true, code: 0, stdout: output, stderr: '', output };
}
function execTimeout(): RunChildResultLike {
  return { ok: false, code: -1, stdout: '', stderr: '', output: '', timedOut: true };
}

/** Reply to a git subcommand based on its argv. */
function routeGit(args: string[]): RunChildResultLike {
  if (args[0] === 'symbolic-ref') return execOk('main');
  if (args[0] === 'rev-parse') return execOk('aaa111');
  if (args[0] === 'ls-remote') return execOk('bbb222\trefs/heads/main');
  if (args[0] === 'pull') return execOk('Already up to date.');
  return execOk('');
}

describe('GET /api/git/status — cache + timeout', () => {
  let app: FastifyInstance;

  async function buildApp(): Promise<FastifyInstance> {
    const a = Fastify();
    // Fresh module instance per app so the module-level cache resets between tests.
    vi.resetModules();
    const { gitRoutes } = await import('../git.js');
    await a.register(gitRoutes);
    await a.ready();
    return a;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRunChild.mockImplementation(async (_cmd, args) => routeGit(args));
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('passes a timeoutMs to every git probe', async () => {
    await app.inject({ method: 'GET', url: '/api/git/status' });
    for (const call of mockRunChild.mock.calls) {
      expect(call[2]).toMatchObject({ timeoutMs: 15_000 });
    }
  });

  it('concurrent callers share one sweep (single symbolic-ref spawn)', async () => {
    const [r1, r2] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/git/status' }),
      app.inject({ method: 'GET', url: '/api/git/status' }),
    ]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    const symbolicRef = mockRunChild.mock.calls.filter((c) => c[1][0] === 'symbolic-ref');
    expect(symbolicRef).toHaveLength(1);
  });

  it('a repeat call inside the TTL returns the cache without re-spawning git', async () => {
    await app.inject({ method: 'GET', url: '/api/git/status' });
    const after = mockRunChild.mock.calls.length;
    await app.inject({ method: 'GET', url: '/api/git/status' });
    expect(mockRunChild.mock.calls.length).toBe(after);
  });

  it('a successful pull clears the cache so the next status re-sweeps', async () => {
    await app.inject({ method: 'GET', url: '/api/git/status' });
    const before = mockRunChild.mock.calls.filter((c) => c[1][0] === 'symbolic-ref').length;

    const pull = await app.inject({
      method: 'POST',
      url: '/api/git/pull',
      payload: { tool: 'root', type: '', project: '' },
    });
    expect(pull.json()).toMatchObject({ success: true });

    await app.inject({ method: 'GET', url: '/api/git/status' });
    const after = mockRunChild.mock.calls.filter((c) => c[1][0] === 'symbolic-ref').length;
    expect(after).toBe(before + 1);
  });

  it("a hung ls-remote yields error: 'timeout'", async () => {
    mockRunChild.mockImplementation(async (_cmd, args) => {
      if (args[0] === 'ls-remote') return execTimeout();
      return routeGit(args);
    });
    app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/git/status' });
    const body = res.json() as {
      items: Array<{ project: string; localHash: string; error?: string }>;
    };
    const root = body.items.find((i) => i.project === '(workspace)');
    expect(root?.error).toBe('timeout');
    // Other fields still return: local hash was resolved before the timeout.
    expect(root?.localHash).toBe('aaa111');
  });
});
