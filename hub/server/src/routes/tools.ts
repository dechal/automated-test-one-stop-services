import type { LifecycleResult, ProvisionResult, ToolRegistryView, ToolView } from '@hub/shared';
import type { FastifyInstance } from 'fastify';
import { WORKSPACE_ROOT } from '../config.js';
import { SAFE_GIT_REF, SAFE_ID } from '../lib/safe-id.js';
import { invalidateDoctorCache } from '../services/doctor.js';
import { getManifestModule, getRegistry } from '../services/manifest-registry.js';
import {
  defaultPostInstallEffects,
  type InstallDepsResult,
  type InstallOpts,
  type InstallResult,
  installDepsForTool,
  installFromRegistry,
  listToolViews,
  refreshAndCount,
  runPostInstallHook,
  setEnabled,
  type UninstallConflict,
  type UpdateToolResult,
  uninstall,
  updateTool,
} from '../services/tool-plugins.js';
import { syncWorkspaceInProcess, withResync } from '../services/workspace-sync.js';

/**
 * Cache of git-remote reachability so the `/api/tool-registry` endpoint does
 * NOT spawn a `git ls-remote` process on every fetch (the marketplace dialog is
 * always mounted on the Projects page, so the query fires on load + on refocus).
 * Keyed by gitUrl; entries live for REACHABILITY_TTL_MS.
 */
const REACHABILITY_TTL_MS = 5 * 60_000;
const reachabilityCache = new Map<string, { reachable: boolean; at: number }>();

/**
 * Validates git URLs before they reach a shell. Accepts https://, ssh://git@,
 * or git@host:path forms. Mirrors the SAFE_GIT_URL guard in tool-plugins.ts.
 */
const SAFE_GIT_URL = /^(?:https:\/\/|ssh:\/\/git@|git@)[A-Za-z0-9._:/~@?=+-]+(?:\.git)?$/;

/**
 * Check if a git remote is reachable by running `git ls-remote --exit-code`.
 * Returns true if the remote responds within the timeout, false otherwise.
 * Never throws — network failures degrade to "unreachable". Results are cached
 * for REACHABILITY_TTL_MS to avoid spawning a git process on every request.
 * `windowsHide` prevents a console window from flashing on Windows. The URL is
 * validated against SAFE_GIT_URL before reaching the shell (defence in depth —
 * registry data is trusted, but this is the one git/shell boundary).
 */
async function isGitReachable(gitUrl: string): Promise<boolean> {
  if (!SAFE_GIT_URL.test(gitUrl)) return false;

  const now = Date.now();
  const cached = reachabilityCache.get(gitUrl);
  if (cached && now - cached.at < REACHABILITY_TTL_MS) {
    return cached.reachable;
  }

  const { execSync } = await import('node:child_process');
  let reachable: boolean;
  try {
    execSync(`git ls-remote --exit-code "${gitUrl}"`, {
      stdio: 'pipe',
      timeout: 10_000,
      windowsHide: true,
    });
    reachable = true;
  } catch {
    reachable = false;
  }
  reachabilityCache.set(gitUrl, { reachable, at: now });
  return reachable;
}

export async function toolPluginRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/tool-registry — list registry entries for the marketplace dialog.
   * Entries whose gitUrl is unreachable (git ls-remote fails) are excluded so
   * only installable tools are presented. Each entry carries an `installed` flag.
   */
  app.get('/api/tool-registry', async (): Promise<ToolRegistryView> => {
    const mod = await getManifestModule();
    const toolRegistry = await mod.loadToolRegistry(WORKSPACE_ROOT);
    const reg = await getRegistry();
    const installedIds = new Set<string>(
      reg
        .all()
        .map((r) => r.manifest?.id)
        .filter((id): id is NonNullable<typeof id> => id !== undefined),
    );

    // Check reachability in parallel (git ls-remote, 10s timeout per entry).
    const results = await Promise.allSettled(
      toolRegistry.tools.map(async (entry) => {
        const reachable = await isGitReachable(entry.gitUrl);
        return reachable ? entry : null;
      }),
    );

    const entries = results
      .map((r) => (r.status === 'fulfilled' ? r.value : null))
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .map((entry) => ({
        name: entry.name,
        title: entry.title,
        description: entry.description,
        gitUrl: entry.gitUrl,
        ref: entry.ref,
        installed: installedIds.has(entry.name),
      }));

    return { entries };
  });
  /** GET /api/tools — list all discovered tools as ToolView[]. */
  app.get('/api/tools', async () => {
    return listToolViews();
  });

  /** GET /api/tools/:id — single tool by id. */
  app.get<{ Params: { id: string } }>('/api/tools/:id', async (req, reply) => {
    if (!SAFE_ID.test(req.params.id)) {
      reply.status(400);
      return { code: 'INVALID_TOOL_NAME', message: 'id contains unsafe characters' };
    }
    const views = await listToolViews();
    const found = views.find((v) => v.id === req.params.id);
    if (!found) {
      reply.status(404);
      return { code: 'MANIFEST_NOT_FOUND', message: `Tool '${req.params.id}' not found` };
    }
    return found;
  });

  /** POST /api/tools/:id/enable — enable a tool and resync workspace.
   *  Default scope is `'local'` (per-developer, gitignored `.tool-overrides.json`)
   *  so enabling/disabling never produces a committed manifest diff. Pass
   *  `scope: 'commit'` explicitly to change the shared default for the whole team. */
  app.post<{ Params: { id: string }; Body: { scope?: 'commit' | 'local' } }>(
    '/api/tools/:id/enable',
    async (req, reply) => {
      if (!SAFE_ID.test(req.params.id)) {
        reply.status(400);
        return { code: 'INVALID_TOOL_NAME', message: 'id contains unsafe characters' };
      }
      const scope = req.body?.scope ?? 'local';
      const result: LifecycleResult<ToolView> = await withResync(async () => {
        const lr = await setEnabled(req.params.id, true, scope);
        return lr.result;
      });
      return result;
    },
  );

  /** POST /api/tools/:id/disable — disable a tool and resync workspace.
   *  Default scope is `'local'` (per-developer, gitignored) — see /enable. */
  app.post<{ Params: { id: string }; Body: { scope?: 'commit' | 'local' } }>(
    '/api/tools/:id/disable',
    async (req, reply) => {
      if (!SAFE_ID.test(req.params.id)) {
        reply.status(400);
        return { code: 'INVALID_TOOL_NAME', message: 'id contains unsafe characters' };
      }
      const scope = req.body?.scope ?? 'local';
      const result: LifecycleResult<ToolView> = await withResync(async () => {
        const lr = await setEnabled(req.params.id, false, scope);
        return lr.result;
      });
      return result;
    },
  );

  /** POST /api/tools/refresh — rescan and revalidate all manifests. */
  app.post('/api/tools/refresh', async () => {
    return { refreshed: await refreshAndCount() };
  });

  /** POST /api/workspace/resync — manual workspace re-sync (escape hatch). */
  app.post('/api/workspace/resync', async () => {
    return syncWorkspaceInProcess();
  });

  // ─── Lifecycle Routes ─────────────────────────────────────────────────────

  /** POST /api/tools/install — two-phase install from the tool registry. */
  app.post<{
    Body: { name: string; confirm?: boolean; abort?: boolean; editPyproject?: boolean };
  }>('/api/tools/install', async (req, reply) => {
    const { name, confirm, abort, editPyproject } = req.body ?? {};
    if (!name || !SAFE_ID.test(name)) {
      reply.status(400);
      return { code: 'INVALID_TOOL_NAME', message: 'name contains unsafe characters' };
    }
    const opts: InstallOpts = { confirm, abort, editPyproject };
    const result: InstallResult = await installFromRegistry(name, opts);
    return result;
  });

  /** POST /api/tools/:id/uninstall — remove a tool from the workspace. */
  app.post<{ Params: { id: string } }>('/api/tools/:id/uninstall', async (req, reply) => {
    if (!SAFE_ID.test(req.params.id)) {
      reply.status(400);
      return { code: 'INVALID_TOOL_NAME', message: 'id contains unsafe characters' };
    }
    const result: UninstallConflict | LifecycleResult<{ removed: string }> = await uninstall(
      req.params.id,
    );
    if ('code' in result && result.code === 'TOOL_HAS_PROJECTS') {
      reply.status(409);
    }
    return result;
  });

  /** POST /api/tools/:id/update — update a registry-installed tool to a newer ref. */
  app.post<{ Params: { id: string }; Body: { ref?: string } }>(
    '/api/tools/:id/update',
    async (req, reply) => {
      if (!SAFE_ID.test(req.params.id)) {
        reply.status(400);
        return { code: 'INVALID_TOOL_NAME', message: 'id contains unsafe characters' };
      }
      const ref = req.body?.ref;
      if (ref !== undefined && !SAFE_GIT_REF.test(ref)) {
        reply.status(400);
        return { code: 'INVALID_REF', message: 'ref contains unsafe characters' };
      }
      const result: UpdateToolResult = await updateTool(req.params.id, ref);
      if (!result.ok) {
        const statusMap: Record<string, number> = {
          NOT_REGISTRY_INSTALLED: 400,
          INVALID_MANIFEST_AFTER_UPDATE: 400,
          LOCAL_EDITS_PRESENT: 409,
        };
        reply.status(statusMap[result.error.code] ?? 400);
        return result.error;
      }
      return result.lifecycle;
    },
  );

  /**
   * POST /api/tools/:id/install-deps — wire + install dependencies for a
   * manually-cloned tool. Validates `:id` with SAFE_ID before any FS/git.
   * Unknown/disabled tool → 404 TOOL_NOT_FOUND; invalid id → 400
   * INVALID_TOOL_NAME. Reuses the shared resync/confirm entry point (no
   * duplicated package-manager spawn logic); origin is reported as `local`.
   */
  app.post<{ Params: { id: string }; Body: { editPyproject?: boolean } }>(
    '/api/tools/:id/install-deps',
    async (req, reply) => {
      if (!SAFE_ID.test(req.params.id)) {
        reply.status(400);
        return { code: 'INVALID_TOOL_NAME', message: 'id contains unsafe characters' };
      }
      const result: InstallDepsResult = await installDepsForTool(req.params.id, {
        editPyproject: req.body?.editPyproject,
      });
      if ('code' in result) {
        reply.status(result.code === 'TOOL_NOT_FOUND' ? 404 : 400);
      }
      return result;
    },
  );

  /**
   * POST /api/tools/:id/provision — (re-)run the tool's `setup` task to
   * provision its browsers/binary (the Post_Install_Hook). Validates `:id` with
   * SAFE_ID (400 INVALID_TOOL_NAME) BEFORE any side effect. Reuses
   * `runPostInstallHook` + `defaultPostInstallEffects`, so the spawned command is
   * the fixed constant `task --taskfile tools/<id>/Taskfile.yml --dir tools/<id>
   * setup` — no tool-supplied string ever reaches the shell. A tool with no
   * `setup` task is a no-op success. Always 200 with the result; a provisioning
   * failure is reported in-band as `{ ok: false, postInstallError }` (not an HTTP
   * error) so the client can render actionable guidance from it. The doctor
   * cache is invalidated so the next `/api/doctor` reflects the new state.
   */
  app.post<{ Params: { id: string } }>('/api/tools/:id/provision', async (req, reply) => {
    if (!SAFE_ID.test(req.params.id)) {
      reply.status(400);
      return { code: 'INVALID_TOOL_NAME', message: 'id contains unsafe characters' };
    }
    const postInstallError = runPostInstallHook(req.params.id, defaultPostInstallEffects());
    invalidateDoctorCache();
    const result: ProvisionResult = postInstallError
      ? { ok: false, postInstallError }
      : { ok: true };
    return result;
  });
}

export default toolPluginRoutes;
