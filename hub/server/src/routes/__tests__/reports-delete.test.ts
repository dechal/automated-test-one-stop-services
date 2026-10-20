import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route test for DELETE /api/reports lock-safe failure. When the retrying
 * remover still cannot delete the report directory (a Windows file lock
 * outlasting the retries), the route must surface a stable 409 REPORT_LOCKED
 * code rather than a bare 500, so the client can render an honest cause.
 */

const OUTPUTS = '/abs/outputs';

vi.mock('../../config.js', () => ({
  OUTPUTS_DIR: OUTPUTS,
  WORKSPACE_ROOT: '/abs',
  SERVER_PKG_DIR: '/abs/hub/server',
}));

const mockExistsSync = vi.fn(() => true);
vi.mock('node:fs', () => ({
  default: {
    existsSync: (...a: unknown[]) => mockExistsSync(...(a as [])),
    createReadStream: vi.fn(),
  },
}));

const mockRemoveDirWithRetry = vi.fn();
vi.mock('../../services/fs-remove.js', () => ({
  removeDirWithRetry: (...a: unknown[]) => mockRemoveDirWithRetry(...a),
}));

vi.mock('../../services/path-guard.js', () => ({
  isUnderOutputs: () => true,
}));

const mockIsFavorite = vi.fn(() => false);
const mockInvalidateReportsCache = vi.fn();
vi.mock('../../services/reports.js', () => ({
  favoriteReport: vi.fn(),
  invalidateReportsCache: (...a: unknown[]) => mockInvalidateReportsCache(...a),
  isFavorite: (...a: unknown[]) => mockIsFavorite(...(a as [])),
  listReports: vi.fn(async () => ({ reports: [] })),
  lockReport: vi.fn(),
  unfavoriteReport: vi.fn(),
  unlockReport: vi.fn(),
}));

vi.mock('../../services/run-compare.js', () => ({
  artifactTestIndex: vi.fn(),
}));

vi.mock('../../services/trace-processes.js', () => ({
  getTraceProcess: vi.fn(),
  killTraceProcess: vi.fn(),
  registerTraceProcess: vi.fn(),
  unregisterTraceProcess: vi.fn(),
}));

describe('DELETE /api/reports — lock-safe delete', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockIsFavorite.mockReturnValue(false);
    app = Fastify();
    const { reportRoutes } = await import('../reports.js');
    await app.register(reportRoutes);
    await app.ready();
  });

  it('returns 409 REPORT_LOCKED when the remove still fails after retries', async () => {
    mockRemoveDirWithRetry.mockImplementation(() => {
      throw new Error('EBUSY: resource busy or locked');
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/reports?path=${encodeURIComponent('/abs/outputs/playwright/web/p/success/2026-01-01/10-00-00/html-results/index.html')}`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'REPORT_LOCKED' });
    expect(mockInvalidateReportsCache).not.toHaveBeenCalled();
  });

  it('returns success when the remove succeeds', async () => {
    mockRemoveDirWithRetry.mockImplementation(() => {});
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/reports?path=${encodeURIComponent('/abs/outputs/playwright/web/p/success/2026-01-01/10-00-00/html-results/index.html')}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true });
    expect(mockRemoveDirWithRetry).toHaveBeenCalledOnce();
    expect(mockInvalidateReportsCache).toHaveBeenCalledOnce();
  });
});
