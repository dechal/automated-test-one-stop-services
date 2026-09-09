// hub/server/src/routes/__tests__/tool-lifecycle-acceptance.test.ts
//
// Tool-lifecycle acceptance test — end-to-end on a temp workspace.
//
// Seeds a temporary workspace with the three real tool manifests + compose
// templates + pipeline.static.json, then exercises the full lifecycle:
//   1. List all tools → 3 entries, all enabled
//   2. Disable k6 (commit scope) → manifest updated, resync regenerates pipeline.json
//   3. Enable k6 → flips back to enabled
//   4. Disable k6 (local scope) → override file written, manifest unchanged
//   5. Force broken template → resync fails with RESYNC_FAILED
//
// Uses Fastify app.inject() for HTTP-level assertions. The route handlers are
// wired to a custom service layer parameterized with the temp workspace root,
// bypassing the config module's hardcoded WORKSPACE_ROOT.
//
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LifecycleResult, ToolView } from '@hub/shared';
import { SAFE_ID } from '@server/lib/safe-id.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ─── Workspace paths (real workspace for source material) ────────────────────

const REAL_WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const REAL_TOOLS_DIR = path.join(REAL_WORKSPACE_ROOT, 'tools');
const REAL_STATIC = path.join(REAL_WORKSPACE_ROOT, 'config', 'pipeline.static.json');

const EXISTING_TOOL_IDS = ['playwright', 'robot-framework', 'k6'] as const;

// ─── Dynamically imported manifest + sync modules ────────────────────────────

interface ManifestModule {
  createManifestRegistry: (workspaceRoot: string) => ManifestRegistry;
  setToolEnabled: (
    registry: ManifestRegistry,
    id: string,
    enabled: boolean,
  ) => Promise<ToolManifestRecord>;
  listProjectDirs: (toolDir: string, cfg: ToolProjectsConfig) => string[];
}

interface ManifestRegistry {
  all(): readonly ToolManifestRecord[];
  enabled(): readonly ToolManifest[];
  byId(id: string): ToolManifest | undefined;
  refresh(): Promise<void>;
}

interface ToolManifest {
  readonly id: string;
  readonly alias: string;
  readonly title: string;
  readonly description: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly runtime: 'node' | 'python' | 'binary';
  readonly packageManager: 'pnpm' | 'uv' | 'none';
  readonly projects: ToolProjectsConfig;
  readonly runner: { readonly taskNamespace: string };
}

interface ToolProjectsConfig {
  readonly root: string;
  readonly depth: 1 | 2;
  readonly typeAxis: boolean;
  readonly fixedType: string | null;
  readonly templates: Readonly<Record<string, string>>;
  readonly specsSubdir: string;
  readonly sectionAxis: boolean;
}

interface ManifestError {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

interface ToolManifestRecord {
  readonly path: string;
  readonly status: 'ok' | 'invalid' | 'disabled';
  readonly manifest: ToolManifest | null;
  readonly errors: readonly ManifestError[];
}

interface SyncModule {
  syncWorkspace: (opts: { root: string }) => Promise<{ regeneratedFiles: string[] }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(prefix = 'tool-lifecycle-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mkDir(...segments: string[]): string {
  const target = path.join(...segments);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

/** Seed a temp workspace with all three tool manifests + compose templates + pipeline.static.json. */
function seedWorkspace(): string {
  const tmpDir = makeTmpDir();
  for (const id of EXISTING_TOOL_IDS) {
    const toolDir = mkDir(tmpDir, 'tools', id);
    fs.copyFileSync(
      path.join(REAL_TOOLS_DIR, id, 'tool.manifest.json'),
      path.join(toolDir, 'tool.manifest.json'),
    );
    const composeTemplate = path.join(REAL_TOOLS_DIR, id, 'docker-compose.template.yml');
    if (fs.existsSync(composeTemplate)) {
      fs.copyFileSync(composeTemplate, path.join(toolDir, 'docker-compose.template.yml'));
    }
    const tsconfigTemplate = path.join(REAL_TOOLS_DIR, id, 'tsconfig.template.json');
    if (fs.existsSync(tsconfigTemplate)) {
      fs.copyFileSync(tsconfigTemplate, path.join(toolDir, 'tsconfig.template.json'));
    }
  }
  const settings = mkDir(tmpDir, 'config');
  fs.copyFileSync(REAL_STATIC, path.join(settings, 'pipeline.static.json'));
  return tmpDir;
}

// ─── Service layer parameterized with temp root ──────────────────────────────

/**
 * Creates a mini service layer (same logic as hub/server/src/services/tool-plugins.ts
 * and workspace-sync.ts) but parameterized with a specific workspace root instead
 * of importing from the config module. Enables testing the real lifecycle
 * without module-mocking.
 */
function createTestServices(tmpDir: string, mod: ManifestModule, sync: SyncModule) {
  const toolsDir = path.join(tmpDir, 'tools');
  let registry: ManifestRegistry | null = null;

  async function getRegistry(): Promise<ManifestRegistry> {
    if (!registry) {
      registry = mod.createManifestRegistry(tmpDir);
      await registry.refresh();
    }
    return registry;
  }

  function detectOrigin(toolId: string): { origin: 'local' | 'registry'; originRef?: string } {
    const toolGitDir = path.join(toolsDir, toolId, '.git');
    if (fs.existsSync(toolGitDir)) return { origin: 'registry' };
    return { origin: 'local' };
  }

  function extractIdFromPath(manifestPath: string): string {
    return path.basename(path.dirname(manifestPath));
  }

  async function listToolViews(): Promise<ToolView[]> {
    const reg = await getRegistry();
    const records = reg.all();
    return records.map((record): ToolView => {
      if (record.manifest === null) {
        const id = extractIdFromPath(record.path);
        return {
          id,
          alias: '',
          title: id,
          description: '',
          version: '',
          status: 'broken',
          runtime: 'node',
          packageManager: 'pnpm',
          projectCount: 0,
          manifestPath: path.relative(tmpDir, record.path),
          errors: record.errors.map((e) => ({ code: e.code, message: e.message })),
          projects: {
            depth: 2,
            typeAxis: false,
            fixedType: null,
            root: 'projects',
            sectionAxis: false,
          },
          capabilities: {
            tagsStrategy: 'none',
            reportKind: null,
            resultGlob: '**/*.html',
            runVars: [],
            supportsHeadless: false,
          },
          ...detectOrigin(id),
        };
      }
      const manifest = record.manifest;
      const toolDir = path.join(toolsDir, manifest.id);
      const projectCount = mod.listProjectDirs(toolDir, manifest.projects).length;
      const status = record.status === 'ok' ? 'enabled' : 'disabled';
      return {
        id: manifest.id,
        alias: manifest.alias,
        title: manifest.title,
        description: manifest.description,
        version: manifest.version,
        status: status as ToolView['status'],
        runtime: manifest.runtime,
        packageManager: manifest.packageManager,
        projectCount,
        manifestPath: path.relative(tmpDir, record.path),
        errors: [],
        projects: {
          depth: manifest.projects.depth,
          typeAxis: manifest.projects.typeAxis,
          fixedType: manifest.projects.fixedType,
          root: manifest.projects.root,
          sectionAxis: manifest.projects.sectionAxis,
        },
        capabilities: {
          tagsStrategy: 'none',
          reportKind: null,
          resultGlob: '**/*.html',
          runVars: [],
          supportsHeadless: false,
        },
        ...detectOrigin(manifest.id),
      };
    });
  }

  const OVERRIDES_PATH = path.join(tmpDir, 'config', '.tool-overrides.json');

  function writeLocalOverride(id: string, enabled: boolean): void {
    let overrides: Record<string, { enabled?: boolean }> = {};
    if (fs.existsSync(OVERRIDES_PATH)) {
      try {
        overrides = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
      } catch {
        overrides = {};
      }
    }
    overrides[id] = { enabled };
    const dir = path.dirname(OVERRIDES_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(OVERRIDES_PATH, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8');
  }

  async function setEnabled(
    id: string,
    enabled: boolean,
    scope: 'commit' | 'local',
  ): Promise<ToolView> {
    const reg = await getRegistry();
    if (scope === 'local') {
      writeLocalOverride(id, enabled);
      await reg.refresh();
    } else {
      await mod.setToolEnabled(reg, id, enabled);
    }
    const views = await listToolViews();
    const updated = views.find((v) => v.id === id);
    if (!updated) throw new Error(`Tool ${id} not found after setEnabled`);
    return updated;
  }

  async function syncWorkspaceInProcess(): Promise<{
    resynced: boolean;
    regeneratedFiles: string[];
    resyncError?: { code: string; message: string };
  }> {
    try {
      const out = await sync.syncWorkspace({ root: tmpDir });
      return { resynced: true, regeneratedFiles: out.regeneratedFiles };
    } catch (err) {
      return {
        resynced: false,
        regeneratedFiles: [],
        resyncError: {
          code: 'RESYNC_FAILED',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  async function withResync<T>(doMutation: () => Promise<T>): Promise<LifecycleResult<T>> {
    const result = await doMutation();
    const resyncResult = await syncWorkspaceInProcess();
    return { result, ...resyncResult };
  }

  return { listToolViews, setEnabled, syncWorkspaceInProcess, withResync };
}

// ─── Fastify app builder ─────────────────────────────────────────────────────

function buildTestApp(services: ReturnType<typeof createTestServices>): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/api/tools', async () => {
    return services.listToolViews();
  });

  app.get<{ Params: { id: string } }>('/api/tools/:id', async (req, reply) => {
    if (!SAFE_ID.test(req.params.id)) {
      reply.status(400);
      return { code: 'INVALID_TOOL_NAME', message: 'id contains unsafe characters' };
    }
    const views = await services.listToolViews();
    const found = views.find((v) => v.id === req.params.id);
    if (!found) {
      reply.status(404);
      return { code: 'MANIFEST_NOT_FOUND', message: `Tool '${req.params.id}' not found` };
    }
    return found;
  });

  app.post<{ Params: { id: string }; Body: { scope?: 'commit' | 'local' } }>(
    '/api/tools/:id/enable',
    async (req, reply) => {
      if (!SAFE_ID.test(req.params.id)) {
        reply.status(400);
        return { code: 'INVALID_TOOL_NAME', message: 'id contains unsafe characters' };
      }
      const scope = req.body?.scope ?? 'commit';
      const result: LifecycleResult<ToolView> = await services.withResync(async () => {
        return services.setEnabled(req.params.id, true, scope);
      });
      return result;
    },
  );

  app.post<{ Params: { id: string }; Body: { scope?: 'commit' | 'local' } }>(
    '/api/tools/:id/disable',
    async (req, reply) => {
      if (!SAFE_ID.test(req.params.id)) {
        reply.status(400);
        return { code: 'INVALID_TOOL_NAME', message: 'id contains unsafe characters' };
      }
      const scope = req.body?.scope ?? 'commit';
      const result: LifecycleResult<ToolView> = await services.withResync(async () => {
        return services.setEnabled(req.params.id, false, scope);
      });
      return result;
    },
  );

  app.post('/api/workspace/resync', async () => {
    return services.syncWorkspaceInProcess();
  });

  return app;
}

// ─── Test suite ──────────────────────────────────────────────────────────────

// Seeds the temp workspace from the REAL tool manifests, which live in
// git-ignored repos absent from a fresh clone / CI — skip when not present.
const TOOLS_PRESENT = EXISTING_TOOL_IDS.every((id) =>
  fs.existsSync(path.join(REAL_TOOLS_DIR, id, 'tool.manifest.json')),
);

describe.skipIf(!TOOLS_PRESENT)('tool lifecycle: end-to-end on temp workspace', () => {
  let tmpDir: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    // Load modules from real workspace scripts via dynamic import
    const manifestPath = path.join(REAL_WORKSPACE_ROOT, 'scripts', 'manifests', 'index.ts');
    const manifestMod = (await import(pathToFileURL(manifestPath).href)) as ManifestModule;

    const syncPath = path.join(REAL_WORKSPACE_ROOT, 'scripts', 'sync-projects.ts');
    const syncMod = (await import(pathToFileURL(syncPath).href)) as SyncModule;

    // Seed temp workspace and build the test app
    tmpDir = seedWorkspace();
    const services = createTestServices(tmpDir, manifestMod, syncMod);
    app = buildTestApp(services);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Scenario 1: GET /api/tools returns three entries, all enabled ─────────

  it('GET /api/tools returns three tools, all status === "enabled"', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tools' });
    expect(res.statusCode).toBe(200);
    const tools = res.json<ToolView[]>();
    expect(tools).toHaveLength(3);
    for (const tool of tools) {
      expect(tool.status).toBe('enabled');
    }
    const ids = tools.map((t) => t.id).sort();
    expect(ids).toEqual(['k6', 'playwright', 'robot-framework']);
  });

  // ── Scenario 2: POST /api/tools/k6/disable (commit scope) ─────────────────

  it('POST /api/tools/k6/disable carries resynced:true and regeneratedFiles includes pipeline.json', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tools/k6/disable',
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<LifecycleResult<ToolView>>();
    expect(body.resynced).toBe(true);
    expect(body.regeneratedFiles.some((f) => f.includes('pipeline.json'))).toBe(true);
    expect(body.result.status).toBe('disabled');
    expect(body.result.id).toBe('k6');
  });

  it('after disable, tools/k6/tool.manifest.json has enabled === false', () => {
    const manifestPath = path.join(tmpDir, 'tools', 'k6', 'tool.manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.enabled).toBe(false);
  });

  // ── Scenario 3: POST /api/tools/k6/enable reverses the change ─────────────

  it('POST /api/tools/k6/enable flips enabled back to true', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tools/k6/enable',
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<LifecycleResult<ToolView>>();
    expect(body.resynced).toBe(true);
    expect(body.result.status).toBe('enabled');
    expect(body.result.id).toBe('k6');
  });

  it('after enable, tools/k6/tool.manifest.json has enabled === true', () => {
    const manifestPath = path.join(tmpDir, 'tools', 'k6', 'tool.manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.enabled).toBe(true);
  });

  // ── Scenario 4: POST /api/tools/k6/disable { scope: 'local' } ─────────────

  it('POST /api/tools/k6/disable with scope:local writes config/.tool-overrides.json', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tools/k6/disable',
      payload: { scope: 'local' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<LifecycleResult<ToolView>>();
    expect(body.result.status).toBe('disabled');

    // Verify override file is written correctly
    const overridesPath = path.join(tmpDir, 'config', '.tool-overrides.json');
    expect(fs.existsSync(overridesPath)).toBe(true);
    const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
    expect(overrides).toEqual({ k6: { enabled: false } });

    // Verify manifest file itself is UNCHANGED (still enabled: true)
    const manifestPath = path.join(tmpDir, 'tools', 'k6', 'tool.manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.enabled).toBe(true);
  });

  // Clean up local override for the broken-template test
  it('cleanup: remove override and re-enable k6 to restore state', async () => {
    const overridesPath = path.join(tmpDir, 'config', '.tool-overrides.json');
    if (fs.existsSync(overridesPath)) fs.rmSync(overridesPath);

    const res = await app.inject({
      method: 'POST',
      url: '/api/tools/k6/enable',
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<LifecycleResult<ToolView>>();
    expect(body.result.status).toBe('enabled');
  });

  // ── Scenario 5: Broken template → resync fails with RESYNC_FAILED ─────────

  it('broken compose template: disable on another tool returns resynced:false and resyncError.code === RESYNC_FAILED', async () => {
    // Force a scenario where syncWorkspace actually throws. The compose-gen is
    // tolerant of missing templates (logs ⚠ and continues),
    // so renaming a template alone won't cause a throw. Instead, corrupt
    // pipeline.static.json so that JSON.parse fails inside loadPipelineStatic,
    // which propagates up through syncWorkspace as an unhandled throw.
    const staticPath = path.join(tmpDir, 'config', 'pipeline.static.json');
    const originalContent = fs.readFileSync(staticPath, 'utf8');
    fs.writeFileSync(staticPath, '{ INVALID JSON !!!', 'utf8');

    // Disable playwright — the lifecycle mutation itself succeeds (setEnabled
    // runs before sync), but re-sync will throw on the corrupt JSON.
    const res = await app.inject({
      method: 'POST',
      url: '/api/tools/playwright/disable',
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<LifecycleResult<ToolView>>();

    // The lifecycle change applied (playwright is now disabled)
    expect(body.result.id).toBe('playwright');
    expect(body.result.status).toBe('disabled');

    // Re-sync must have failed
    expect(body.resynced).toBe(false);
    expect(body.resyncError).toBeDefined();
    expect(body.resyncError?.code).toBe('RESYNC_FAILED');

    // Restore pipeline.static.json
    fs.writeFileSync(staticPath, originalContent, 'utf8');
  });
});
