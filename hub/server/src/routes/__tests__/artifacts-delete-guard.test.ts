import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route test for the outputs/ boundary guard on DELETE /api/artifacts and
 * GET /api/artifacts/download-zip. The bug this pins: a bare
 * `resolved.startsWith(outputsResolved)` accepts a SIBLING directory whose path
 * merely begins with the outputs path (e.g. `outputs-evil`), so a recursive
 * `fs.rmSync` could delete a tree outside outputs/. The guard now delegates to
 * `isUnderOutputs`, which appends `path.sep`. We fix OUTPUTS_DIR to a known
 * absolute path via the config mock and assert the sibling is rejected 403 and
 * never reaches `fs.rmSync`/`fs.unlinkSync`.
 */

const OUTPUTS = '/abs/outputs';

vi.mock('../../config.js', () => ({
  OUTPUTS_DIR: OUTPUTS,
  WORKSPACE_ROOT: '/abs',
}));

const mockRmSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockExistsSync = vi.fn(() => true);
const mockStatSync = vi.fn(() => ({ isDirectory: () => true }));
vi.mock('node:fs', () => ({
  default: {
    rmSync: (...a: unknown[]) => mockRmSync(...a),
    unlinkSync: (...a: unknown[]) => mockUnlinkSync(...a),
    existsSync: (...a: unknown[]) => mockExistsSync(...(a as [])),
    statSync: (...a: unknown[]) => mockStatSync(...(a as [])),
  },
}));

vi.mock('../../services/artifacts.js', () => ({
  artifactService: { invalidateBrowseAll: vi.fn() },
}));

vi.mock('../../services/manifest-registry.js', () => ({
  getEnabledToolIds: vi.fn(async () => new Set<string>()),
}));

describe('DELETE /api/artifacts — outputs/ boundary guard', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    app = Fastify();
    const { artifactRoutes } = await import('../artifacts.js');
    await app.register(artifactRoutes);
    await app.ready();
  });

  it('rejects a sibling-prefix path (outputs-evil) with 403 and never deletes', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/artifacts?path=${encodeURIComponent('/abs/outputs-evil/secret')}`,
    });
    expect(res.statusCode).toBe(403);
    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('rejects a parent-escape path (..) with 403 and never deletes', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/artifacts?path=${encodeURIComponent('/abs/outputs/../secret')}`,
    });
    expect(res.statusCode).toBe(403);
    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('allows a real path under outputs/ and deletes it', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/artifacts?path=${encodeURIComponent('/abs/outputs/playwright/run-1')}`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockRmSync).toHaveBeenCalledOnce();
  });
});
