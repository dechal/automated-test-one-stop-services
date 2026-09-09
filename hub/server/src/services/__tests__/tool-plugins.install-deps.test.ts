import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolManifest } from '../manifest-registry.js';

/**
 * Unit tests for the tool-plugins dependency-install behaviour.
 *
 *
 * Strategy: mock the package-manager spawn (`execSync` from `node:child_process`)
 * plus the registry, manifest module, scanner cache, and the `withResync` wrapper
 * so the confirm-phase of `installFromRegistry` runs in isolation. We assert the
 * correct command (`pnpm install` / `uv sync`) is invoked per `packageManager`,
 * that `none` skips the spawn entirely, and that a spawn failure surfaces as
 * `LifecycleResult.depsError` WITHOUT rolling back the cloned tool directory.
 */

// ─── Hoisted spawn mock (referenced inside vi.mock factory) ──────────────────

const { mockExecSync } = vi.hoisted(() => ({ mockExecSync: vi.fn() }));

// ─── Fake manifests (one per packageManager) ─────────────────────────────────

function makeManifest(id: string, packageManager: ToolManifest['packageManager']): ToolManifest {
  return {
    id,
    alias: id,
    title: `${id} tool`,
    description: `${id} description`,
    version: '1.0.0',
    enabled: true,
    runtime: packageManager === 'uv' ? 'python' : packageManager === 'none' ? 'binary' : 'node',
    packageManager,
    projects: {
      root: 'projects',
      depth: 2,
      typeAxis: true,
      fixedType: null,
      templates: { default: `projects/${id}-template-example` },
      specsSubdir: 'automations/specs',
      sectionAxis: false,
    },
    runner: { taskNamespace: id },
    docker: { baseImage: `${id}:latest` },
  };
}

const pnpmManifest = makeManifest('playwright', 'pnpm');
const uvManifest = makeManifest('pytool', 'uv');
const noneManifest = makeManifest('bintool', 'none');

const manifestsById: Record<string, ToolManifest> = {
  playwright: pnpmManifest,
  pytool: uvManifest,
  bintool: noneManifest,
};

const records = Object.values(manifestsById).map((manifest) => ({
  path: `/workspace/tools/${manifest.id}/tool.manifest.json`,
  status: 'ok' as const,
  manifest,
  errors: [] as { code: string; message: string }[],
}));

// ─── Mock registry + manifest module ────────────────────────────────────────

const mockRegistry = {
  all: vi.fn(() => records),
  enabled: vi.fn(() => Object.values(manifestsById)),
  byId: vi.fn((id: string) => manifestsById[id]),
  refresh: vi.fn(async () => {}),
};

const mockManifestModule = {
  listProjectDirs: vi.fn(() => [] as string[]),
  resolveCapabilities: vi.fn(() => ({
    run: { vars: [], headlessVar: null },
    reports: { resultGlob: '**/*.html', kind: null },
    tags: { strategy: 'none' as const },
  })),
};

// ─── Module-level mocks ──────────────────────────────────────────────────────

vi.mock('../../config.js', () => ({
  WORKSPACE_ROOT: '/workspace',
  TOOLS_DIR: '/workspace/tools',
}));

vi.mock('node:child_process', () => ({ execSync: mockExecSync }));

const mockExistsSync = vi.fn(() => false);
const mockRmSync = vi.fn();

vi.mock('node:fs', () => ({
  default: {
    existsSync: mockExistsSync,
    rmSync: mockRmSync,
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
  },
}));

vi.mock('../scanner.js', () => ({
  invalidateProjectCache: vi.fn(),
}));

vi.mock('../manifest-registry.js', () => ({
  getRegistry: vi.fn(async () => mockRegistry),
  getManifestModule: vi.fn(async () => mockManifestModule),
  invalidateManifestRegistry: vi.fn(),
}));

// withResync just runs the mutation and wraps it — the real implementation does
// an in-process workspace re-sync we don't exercise here.
vi.mock('../workspace-sync.js', () => ({
  withResync: vi.fn(async (doMutation: () => Promise<unknown>) => {
    const result = await doMutation();
    return { result, resynced: true, regeneratedFiles: [] };
  }),
}));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('installFromRegistry confirm-phase dependency install', () => {
  let service: typeof import('../tool-plugins.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    service = await import('../tool-plugins.js');
  });

  it('runs `pnpm install` for a pnpm tool', async () => {
    const result = await service.installFromRegistry('playwright', { confirm: true });

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    const [command, options] = mockExecSync.mock.calls[0] as [string, Record<string, unknown>];
    expect(command).toBe('pnpm install --ignore-workspace');
    expect(options).toMatchObject({
      cwd: path.join('/workspace/tools', 'playwright'),
      stdio: 'pipe',
      timeout: 180_000,
    });

    // Successful install → no depsError, clone intact.
    expect(result).not.toHaveProperty('depsError');
    expect(result).toMatchObject({ resynced: true });
  });

  it('runs `uv sync` for a uv tool', async () => {
    const result = await service.installFromRegistry('pytool', { confirm: true });

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    const [command, options] = mockExecSync.mock.calls[0] as [string, Record<string, unknown>];
    expect(command).toBe('uv sync');
    expect(options).toMatchObject({ cwd: '/workspace', stdio: 'pipe', timeout: 180_000 });

    expect(result).not.toHaveProperty('depsError');
  });

  it('skips the spawn entirely for a `none` package manager and still succeeds', async () => {
    const result = await service.installFromRegistry('bintool', { confirm: true });

    expect(mockExecSync).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('depsError');
    expect(result).toMatchObject({ resynced: true });
  });

  it('surfaces a spawn failure as depsError without rolling back the clone', async () => {
    const failure = Object.assign(new Error('command failed'), {
      stderr: Buffer.from('pnpm ERR! network ETIMEDOUT'),
    });
    mockExecSync.mockImplementationOnce(() => {
      throw failure;
    });

    const result = await service.installFromRegistry('playwright', { confirm: true });

    // depsError is surfaced with the captured stderr.
    expect(result).toMatchObject({
      resynced: true,
      depsError: { code: 'DEPS_INSTALL_FAILED', message: 'pnpm ERR! network ETIMEDOUT' },
    });

    // The clone is NEVER rolled back on a deps failure — no directory removal.
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it('falls back to the error message when stderr is empty', async () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('spawn pnpm ENOENT');
    });

    const result = await service.installFromRegistry('playwright', { confirm: true });

    expect(result).toMatchObject({
      depsError: { code: 'DEPS_INSTALL_FAILED', message: 'spawn pnpm ENOENT' },
    });
    expect(mockRmSync).not.toHaveBeenCalled();
  });
});
