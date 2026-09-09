import fs from 'node:fs';
import path from 'node:path';
import type { Bookmark, EnvProfile, RunRecord, WebhookConfig } from '@hub/shared';
import { OUTPUTS_DIR, TOOLS_DIR } from '../config.js';
import { getToolManifest } from './manifest-registry.js';
import { loadJson, saveJson } from './persistence.js';
import { runner } from './runner.js';
import { scheduler } from './scheduler.js';

/** A fully-qualified project coordinate: `tool/type/project`. */
export interface ProjectRef {
  readonly tool: string;
  readonly type: string;
  readonly project: string;
}

/** Counts of everything removed by a cascade — surfaced to the caller/UI. */
export interface ProjectCleanupResult {
  readonly projectDirRemoved: boolean;
  readonly outputsRemoved: boolean;
  readonly historyRemoved: number;
  readonly schedulesRemoved: number;
  readonly bookmarksRemoved: number;
  readonly webhooksRemoved: number;
  readonly envProfilesRemoved: number;
}

const HISTORY = 'history';
const BOOKMARKS_FILE = 'bookmarks.json';
const WEBHOOKS_FILE = 'webhooks.json';
const ENV_PROFILES_FILE = 'env-profiles.json';

/** True when a run/config request targets exactly this project. */
function requestMatches(
  req: { tool?: string; type?: string; project?: string },
  ref: ProjectRef,
): boolean {
  return req.tool === ref.tool && req.type === ref.type && req.project === ref.project;
}

/**
 * Safely remove a directory that MUST live inside `base`. Returns true when a
 * directory existed and was deleted. The `startsWith` guard is defence in depth
 * — the caller already validates `tool/type/project` with SAFE_ID — so a
 * crafted path can never escape the tools/outputs roots.
 */
function safeRemoveDir(base: string, target: string): boolean {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(target);
  if (resolved === resolvedBase || !resolved.startsWith(resolvedBase + path.sep)) {
    return false;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return false;
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  return true;
}

/**
 * Remove a single project and every trace of it across the workspace
 * (Req: "cleanup แบบเต็มระบบ"). Deletes, in order:
 *   1. the project folder under `tools/<tool>/<root>/<type>/<project>`
 *   2. its artifacts under `outputs/<tool>/<type>/<project>`
 *   3. run history rows for the project
 *   4. schedules targeting the project (cron task stopped via scheduler.delete)
 *   5. bookmarks captured for the project
 *   6. webhooks scoped specifically to the project (tool-wide webhooks are kept)
 *   7. env profiles saved for the project
 *   8. the in-memory last-run-status entry
 *
 * Non-destructive to anything outside the project. Deletion is irreversible;
 * the route gates it behind a typed-confirmation (`tool/type/project`).
 */
export async function removeProjectCascade(ref: ProjectRef): Promise<ProjectCleanupResult> {
  const manifest = await getToolManifest(ref.tool);
  const root = manifest?.projects.root ?? 'projects';

  // 1. project folder on disk
  const projectDir = path.join(TOOLS_DIR, ref.tool, root, ref.type, ref.project);
  const projectDirRemoved = safeRemoveDir(TOOLS_DIR, projectDir);

  // 2. artifacts under outputs/
  const outputsDir =
    manifest?.projects.typeAxis === false
      ? path.join(OUTPUTS_DIR, ref.tool, ref.project)
      : path.join(OUTPUTS_DIR, ref.tool, ref.type, ref.project);
  const outputsRemoved = safeRemoveDir(OUTPUTS_DIR, outputsDir);

  // 3. run history
  const history = loadJson<RunRecord[]>(HISTORY, []);
  const keptHistory = history.filter((r) => !requestMatches(r.request, ref));
  const historyRemoved = history.length - keptHistory.length;
  if (historyRemoved > 0) saveJson(HISTORY, keptHistory);

  // 4. schedules — go through the service so the live cron task is stopped too
  let schedulesRemoved = 0;
  for (const schedule of scheduler.getAll()) {
    if (requestMatches(schedule.config, ref)) {
      if (scheduler.delete(schedule.id)) schedulesRemoved++;
    }
  }

  // 5. bookmarks
  const bookmarks = loadJson<Bookmark[]>(BOOKMARKS_FILE, []);
  const keptBookmarks = bookmarks.filter((b) => !requestMatches(b.config, ref));
  const bookmarksRemoved = bookmarks.length - keptBookmarks.length;
  if (bookmarksRemoved > 0) saveJson(BOOKMARKS_FILE, keptBookmarks);

  // 6. webhooks scoped specifically to this project. A webhook is removed when
  //    it targets this project AND its tool scope is either unset or matches.
  //    Tool-wide / type-wide webhooks (no project scope) are preserved.
  const webhooks = loadJson<WebhookConfig[]>(WEBHOOKS_FILE, []);
  const keptWebhooks = webhooks.filter((w) => {
    const scope = w.scope;
    const projectScoped = scope?.project === ref.project;
    const toolMatches = scope?.tool === undefined || scope.tool === ref.tool;
    return !(projectScoped && toolMatches);
  });
  const webhooksRemoved = webhooks.length - keptWebhooks.length;
  if (webhooksRemoved > 0) saveJson(WEBHOOKS_FILE, keptWebhooks);

  // 7. env profiles
  const envProfiles = loadJson<EnvProfile[]>(ENV_PROFILES_FILE, []);
  const keptProfiles = envProfiles.filter((p) => !requestMatches(p, ref));
  const envProfilesRemoved = envProfiles.length - keptProfiles.length;
  if (envProfilesRemoved > 0) saveJson(ENV_PROFILES_FILE, keptProfiles);

  // 8. forget the cached last-run status
  runner.forgetProject(ref.tool, ref.type, ref.project);

  return {
    projectDirRemoved,
    outputsRemoved,
    historyRemoved,
    schedulesRemoved,
    bookmarksRemoved,
    webhooksRemoved,
    envProfilesRemoved,
  };
}
