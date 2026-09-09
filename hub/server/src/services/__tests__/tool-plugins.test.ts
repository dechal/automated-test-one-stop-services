import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the tool-plugins service.
 *
 *
 * Strategy: vi.mock the config and scanner modules; intercept the dynamic ESM
 * import by providing a mock manifest-module factory that controls registry
 * behaviour. The service under test is imported fresh per suite after mocks
 * are installed.
 */

// ─── Fake manifests ──────────────────────────────────────────────────────────

const playwrightManifest = {
  id: 'playwright',
  alias: 'pw',
  title: 'Playwright (Web UI / API)',
  description: 'E2E browser + API testing.',
  version: '1.55.0',
  enabled: true,
  runtime: 'node' as const,
  packageManager: 'pnpm' as const,
  projects: {
    root: 'projects',
    depth: 2 as const,
    typeAxis: true,
    fixedType: null,
    templates: { default: 'projects/web/playwright-web-template-example' },
    specsSubdir: 'automations/specs',
    sectionAxis: false,
  },
  runner: { taskNamespace: 'pw' },
};

const k6Manifest = {
  id: 'k6',
  alias: 'k6',
  title: 'k6 Performance',
  description: 'Load testing with k6.',
  version: '0.50.0',
  enabled: false,
  runtime: 'node' as const,
  packageManager: 'pnpm' as const,
  projects: {
    root: 'projects',
    depth: 1 as const,
    typeAxis: false,
    fixedType: 'performance',
    templates: { default: 'projects/performance/k6-performance-template-example' },
    specsSubdir: 'automations/specs',
    sectionAxis: true,
  },
  runner: { taskNamespace: 'k6' },
};

const records = [
  {
    path: '/workspace/tools/playwright/tool.manifest.json',
    status: 'ok' as const,
    manifest: playwrightManifest,
    errors: [] as { code: string; message: string }[],
  },
  {
    path: '/workspace/tools/k6/tool.manifest.json',
    status: 'disabled' as const,
    manifest: k6Manifest,
    errors: [] as { code: string; message: string }[],
  },
];

// ─── Module-level mocks ──────────────────────────────────────────────────────

vi.mock('../../config.js', () => ({
  WORKSPACE_ROOT: '/workspace',
  TOOLS_DIR: '/workspace/tools',
}));

vi.mock('../scanner.js', () => ({
  invalidateProjectCache: vi.fn(),
}));

// Mock node:fs for the local override write path
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn((p: string) => {
        // .git dir check for origin detection
        if (typeof p === 'string' && p.endsWith('.git')) return false;
        // .tool-overrides.json existence
        if (typeof p === 'string' && p.includes('.tool-overrides.json')) return false;
        // config dir
        if (typeof p === 'string' && p.endsWith('config')) return true;
        return actual.existsSync(p);
      }),
      readFileSync: vi.fn((_p: string) => '{}'),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
  };
});

// The big challenge: intercept dynamic import() inside the service.
// The service does: `await import(pathToFileURL(modulePath).href)`
// We override the returned module by mocking at the import level.

const mockRegistry = {
  all: vi.fn(() => records),
  enabled: vi.fn(() => [playwrightManifest]),
  byId: vi.fn((id: string) => {
    if (id === 'playwright') return playwrightManifest;
    if (id === 'k6') return k6Manifest;
    return undefined;
  }),
  refresh: vi.fn(async () => {}),
};

const mockManifestModule = {
  createManifestRegistry: vi.fn(() => mockRegistry),
  setToolEnabled: vi.fn(async (_reg: unknown, id: string, enabled: boolean) => {
    const r = records.find((rec) => rec.manifest?.id === id);
    if (!r) throw new Error(`Tool ${id} not found`);
    return {
      ...r,
      status: enabled ? ('ok' as const) : ('disabled' as const),
      manifest: r.manifest ? { ...r.manifest, enabled } : null,
    };
  }),
  listProjectDirs: vi.fn(() => ['project-a', 'project-b']),
  resolveCapabilities: vi.fn(() => ({
    run: { vars: [], headlessVar: null },
    reports: { resultGlob: '**/*.html', kind: null },
    tags: { strategy: 'none' as const },
  })),
};

// We need to intercept the dynamic import. The service resolves:
// path.resolve('/workspace', 'scripts', 'manifests', 'index.ts')
// → '/workspace/scripts/manifests/index.ts'
// Then: pathToFileURL('/workspace/scripts/manifests/index.ts').href
// → 'file:///workspace/scripts/manifests/index.ts'
// Then: await import('file:///workspace/scripts/manifests/index.ts')
//
// We'll use a global import hook via vi.stubGlobal or unstable_mockModule.
// The most reliable way in vitest: mock the entire service and test its logic.
// OR: use vi.doMock with dynamic imports in the test.
//
// Actually, let's use a different approach: re-export the service functions
// from a wrapper that we can control. But that changes production code.
//
// FINAL APPROACH: We'll mock at the `node:url` level so pathToFileURL returns
// a known URL, then use vi.doMock to handle that URL pattern.

vi.mock('node:url', () => ({
  pathToFileURL: () => ({ href: 'mock://manifests-module' }),
}));

// Now the service will do: await import('mock://manifests-module')
// We need to make that resolve to our mock. We can do this with vi.doMock:
vi.mock('mock://manifests-module', () => mockManifestModule);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('tool-plugins service', () => {
  let service: typeof import('../tool-plugins.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-import the service fresh (it caches the module internally)
    vi.resetModules();

    // Re-apply mocks after resetModules
    vi.doMock('../config.js', () => ({
      WORKSPACE_ROOT: '/workspace',
      TOOLS_DIR: '/workspace/tools',
    }));
    vi.doMock('./scanner.js', () => ({
      invalidateProjectCache: vi.fn(),
    }));
    vi.doMock('node:url', () => ({
      pathToFileURL: () => ({ href: 'mock://manifests-module' }),
    }));
    vi.doMock('mock://manifests-module', () => mockManifestModule);
    vi.doMock('node:fs', () => ({
      default: {
        existsSync: vi.fn((p: string) => {
          if (typeof p === 'string' && p.endsWith('.git')) return false;
          if (typeof p === 'string' && p.includes('.tool-overrides.json')) return false;
          if (typeof p === 'string' && p.endsWith('.kiro')) return true;
          return false;
        }),
        readFileSync: vi.fn(() => '{}'),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      },
    }));

    service = await import('../tool-plugins.js');
  });

  describe('listToolViews()', () => {
    it('returns ToolView[] with expected shape for all records', async () => {
      const views = await service.listToolViews();

      expect(Array.isArray(views)).toBe(true);
      expect(views).toHaveLength(2);
    });

    it('maps ok-status record to enabled ToolView', async () => {
      const views = await service.listToolViews();
      const pw = views.find((v) => v.id === 'playwright');

      expect(pw).toBeDefined();
      expect(pw!.id).toBe('playwright');
      expect(pw!.alias).toBe('pw');
      expect(pw!.title).toBe('Playwright (Web UI / API)');
      expect(pw!.description).toBe('E2E browser + API testing.');
      expect(pw!.version).toBe('1.55.0');
      expect(pw!.status).toBe('enabled');
      expect(pw!.runtime).toBe('node');
      expect(pw!.packageManager).toBe('pnpm');
      expect(pw!.projectCount).toBe(2); // mockListProjectDirs returns 2 items
      expect(pw!.errors).toEqual([]);
      expect(pw!.origin).toBe('local'); // no .git dir
    });

    it('maps disabled-status record to disabled ToolView', async () => {
      const views = await service.listToolViews();
      const k6 = views.find((v) => v.id === 'k6');

      expect(k6).toBeDefined();
      expect(k6!.status).toBe('disabled');
    });

    it('computes projectCount via listProjectDirs()', async () => {
      mockManifestModule.listProjectDirs.mockReturnValueOnce(['a', 'b', 'c']);
      mockManifestModule.listProjectDirs.mockReturnValueOnce([]);

      const views = await service.listToolViews();
      // First call gets 3 projects, second gets 0
      expect(views[0]?.projectCount).toBe(3);
      expect(views[1]?.projectCount).toBe(0);
    });
  });

  describe('setEnabled()', () => {
    it('with commit scope calls setToolEnabled on the manifest module', async () => {
      const result = await service.setEnabled('playwright', false, 'commit');

      expect(mockManifestModule.setToolEnabled).toHaveBeenCalledWith(
        expect.anything(), // registry
        'playwright',
        false,
      );
      expect(result).toHaveProperty('result');
      expect(result).toHaveProperty('resynced');
      expect(result).toHaveProperty('regeneratedFiles');
    });

    it('with commit scope returns updated ToolView in result', async () => {
      const result = await service.setEnabled('playwright', true, 'commit');

      expect(result.result.id).toBe('playwright');
      expect(result.resynced).toBe(false);
      expect(result.regeneratedFiles).toEqual([]);
    });

    it('with local scope writes to .tool-overrides.json', async () => {
      const fsMod = await import('node:fs');
      await service.setEnabled('k6', false, 'local');

      // Verify writeFileSync was called with the overrides path
      expect(fsMod.default.writeFileSync).toHaveBeenCalled();
      const writeCall = vi.mocked(fsMod.default.writeFileSync).mock.calls[0];
      expect(writeCall).toBeDefined();
      expect(writeCall?.[0]).toContain('.tool-overrides.json');

      // Content should include the tool override
      const content = writeCall?.[1] as string;
      expect(content).toContain('"k6"');
      expect(content).toContain('"enabled": false');
    });

    it('with local scope does NOT call setToolEnabled', async () => {
      await service.setEnabled('k6', false, 'local');
      expect(mockManifestModule.setToolEnabled).not.toHaveBeenCalled();
    });

    it('with local scope refreshes the registry after write', async () => {
      await service.setEnabled('k6', true, 'local');
      expect(mockRegistry.refresh).toHaveBeenCalled();
    });
  });

  describe('refreshAndCount()', () => {
    it('calls registry.refresh() and returns counts', async () => {
      const counts = await service.refreshAndCount();

      expect(mockRegistry.refresh).toHaveBeenCalled();
      expect(counts).toEqual({
        enabled: 1, // playwright (status=ok)
        disabled: 1, // k6 (status=disabled)
        invalid: 0,
      });
    });

    it('counts invalid records correctly', async () => {
      mockRegistry.all.mockReturnValueOnce([
        ...records,
        {
          path: '/workspace/tools/broken/tool.manifest.json',
          status: 'invalid' as const,
          manifest: null,
          errors: [{ code: 'SCHEMA_FAIL', message: 'bad' }],
        } as unknown as (typeof records)[number],
      ]);

      const counts = await service.refreshAndCount();
      expect(counts).toEqual({
        enabled: 1,
        disabled: 1,
        invalid: 1,
      });
    });
  });
});
