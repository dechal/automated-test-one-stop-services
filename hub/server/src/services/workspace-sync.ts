import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LifecycleResult } from '@hub/shared';
import { WORKSPACE_ROOT } from '../config.js';
import { invalidateProjectCache } from './scanner.js';

// ─── Types for the dynamically imported sync-projects module ──────────────────

interface SyncWorkspaceResult {
  regeneratedFiles: string[];
}

interface SyncProjectsModule {
  syncWorkspace: (options: { root: string }) => Promise<SyncWorkspaceResult>;
}

// ─── In-process workspace re-sync ────────────────────────────────────────────

/**
 * Runs `syncWorkspace({ root })` from `scripts/sync-projects.ts` in-process
 * via ESM dynamic import — NOT a child shell spawn.
 *
 * Regenerates: pnpm-workspace.yaml, pyproject.toml [tool.uv.workspace],
 * root docker-compose.yml, per-tool docker-compose.yml, per-tool tsconfig.json,
 * and scripts/manifests/data/pipeline.json.
 */
export async function syncWorkspaceInProcess(): Promise<
  Pick<LifecycleResult<unknown>, 'resynced' | 'regeneratedFiles' | 'resyncError'>
> {
  try {
    const syncScriptPath = path.resolve(WORKSPACE_ROOT, 'scripts', 'sync-projects.ts');
    const moduleUrl = pathToFileURL(syncScriptPath).href;
    const mod = (await import(moduleUrl)) as SyncProjectsModule;
    const out = await mod.syncWorkspace({ root: WORKSPACE_ROOT });
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

// ─── withResync wrapper ──────────────────────────────────────────────────────

/**
 * Wraps any lifecycle mutation (enable/disable/install/uninstall/update) so that
 * workspace artefacts are regenerated automatically after the mutation succeeds.
 *
 * On re-sync success: returns `{ result, resynced: true, regeneratedFiles }`.
 * On re-sync error: returns `{ result, resynced: false, regeneratedFiles: [], resyncError }`.
 * The lifecycle change is NEVER rolled back — re-sync is idempotent, so the
 * recovery is to fix the cause and click "Re-sync workspace".
 */
export async function withResync<T>(doMutation: () => Promise<T>): Promise<LifecycleResult<T>> {
  const result = await doMutation();
  invalidateProjectCache();
  const resync = await syncWorkspaceInProcess();
  return { result, ...resync };
}
