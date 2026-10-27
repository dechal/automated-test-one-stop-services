// hub/server/src/services/manifest-registry.ts
//
// Single owner of the workspace manifest registry inside the Hub server.
// `tool-plugins.ts` (lifecycle) and `scanner.ts` (project listing) both depend
// on THIS module rather than on each other, which avoids a circular import and
// guarantees one cache (no diverging registries). The registry is built by
// dynamically importing `scripts/manifests/index.ts` through the tsx loader
// registered in `index.ts`.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolId } from '@hub/shared';
import { WORKSPACE_ROOT } from '../config.js';

// ─── Types mirrored from scripts/manifests (the dynamically imported module) ──

import type {
  ManifestError,
  ManifestRegistry,
  ResolvedCapabilities,
  ResolvedReportsCapability,
  ResolvedRunCapability,
  ResolvedTagsCapability,
  RunCommandInput,
  ToolManifest,
  ToolManifestRecord,
  ToolProjectsConfig,
  ToolRegistry,
  ToolRegistryEntry,
  ToolReportsCapability,
  ToolRunCapability,
  ToolRunVar,
  ToolRunVarWhen,
  ToolTagsCapability,
  ToolTagsStrategy,
  ValidateManifestResult,
} from '@manifests/index.js';

// ── Optional capability blocks ───────────────────────
// Mirror of the shapes in `scripts/manifests/types.ts`. All optional; absent
// blocks resolve to safe defaults via the canonical `resolveCapabilities()`
// (exposed through `getManifestModule()` below).
/** Known tag-discovery strategies; unknown/absent resolve to `'none'`. */
/**
 * Neutral run context the command-builder maps a `RunRequest` onto before
 * delegating to the canonical `buildRunCommandFromInput()` in
 * `scripts/manifests/runner-command.ts`. Mirror of the shared
 * `RunCommandInput`. `quote` escapes task-var values for safe shell pass-through.
 */
export type {
  ManifestError,
  ManifestRegistry,
  ResolvedCapabilities,
  ResolvedReportsCapability,
  ResolvedRunCapability,
  ResolvedTagsCapability,
  RunCommandInput,
  ToolManifest,
  ToolManifestRecord,
  ToolProjectsConfig,
  ToolRegistry,
  ToolRegistryEntry,
  ToolReportsCapability,
  ToolRunCapability,
  ToolRunVar,
  ToolRunVarWhen,
  ToolTagsCapability,
  ToolTagsStrategy,
  ValidateManifestResult,
};

export type ManifestModule = typeof import('@manifests/index.js');

// ─── Lazy module loader + cached registry ────────────────────────────────────

// Memoize the in-flight PROMISE, not the resolved value: several services
// (scheduler, run route, scanner, tools route) touch these on the same tick at
// boot, and a check-then-await on a resolved-value cache lets two callers both
// pass the guard and build/refresh the registry twice. Mirrors scanner.ts.
let manifestModule: Promise<ManifestModule> | null = null;
let registry: Promise<ManifestRegistry> | null = null;

/** Dynamically import `scripts/manifests/index.ts` (cached). */
export function getManifestModule(): Promise<ManifestModule> {
  if (manifestModule) return manifestModule;
  const modulePath = path.resolve(WORKSPACE_ROOT, 'scripts', 'manifests', 'index.ts');
  const moduleUrl = pathToFileURL(modulePath).href;
  manifestModule = (import(moduleUrl) as Promise<ManifestModule>).catch((err) => {
    manifestModule = null; // let the next caller retry a failed import
    throw err;
  });
  return manifestModule;
}

/** Build (once) and return the cached, refreshed registry. */
export function getRegistry(): Promise<ManifestRegistry> {
  if (registry) return registry;
  registry = (async () => {
    const mod = await getManifestModule();
    const reg = mod.createManifestRegistry(WORKSPACE_ROOT);
    await reg.refresh();
    return reg;
  })().catch((err) => {
    registry = null; // don't cache a failed build
    throw err;
  });
  return registry;
}

/** Enabled, schema-valid manifests. */
export async function getEnabledTools(): Promise<readonly ToolManifest[]> {
  const reg = await getRegistry();
  return reg.enabled();
}

/**
 * Set of enabled tool ids — the shared filter every feature (bookmarks,
 * schedules, history, artifacts, webhooks, scheduler) uses to hide/skip items
 * that belong to a disabled (or uninstalled) tool. Disabling is non-destructive:
 * items are filtered out at read/trigger time, not deleted, so re-enabling the
 * tool brings everything back.
 */
export async function getEnabledToolIds(): Promise<ReadonlySet<string>> {
  return new Set((await getEnabledTools()).map((t) => t.id));
}

/** A single enabled/known manifest by id, or `undefined`. */
export async function getToolManifest(id: ToolId): Promise<ToolManifest | undefined> {
  const reg = await getRegistry();
  return reg.byId(id);
}

/**
 * Resolve a tool's capability blocks (`run`/`reports`/`tags`) to their safe
 * defaults via the canonical `resolveCapabilities()` in `scripts/manifests`.
 * Returns `undefined` only when the tool id is unknown/disabled — callers treat
 * that the same as "no capabilities" (e.g. `tags.strategy` → `'none'`). Never
 * throws: an unknown `tags.strategy` is normalised to `'none'` by the resolver.
 */
export async function getToolCapabilities(id: ToolId): Promise<ResolvedCapabilities | undefined> {
  const manifest = await getToolManifest(id);
  if (manifest === undefined) return undefined;
  const mod = await getManifestModule();
  return mod.resolveCapabilities(manifest);
}

/**
 * Drop the cached registry so the next access rebuilds it. Call after any
 * lifecycle mutation (enable/disable/install/uninstall/update) — pair with
 * `invalidateProjectCache()` in `scanner.ts`.
 */
export function invalidateManifestRegistry(): void {
  registry = null;
}
