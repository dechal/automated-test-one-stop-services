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

export interface ToolProjectsConfig {
  readonly root: string;
  readonly depth: 1 | 2;
  readonly typeAxis: boolean;
  readonly fixedType: string | null;
  readonly templates: Readonly<Record<string, string>>;
  readonly display?: Readonly<Record<string, boolean>>;
  readonly specsSubdir: string;
  readonly sectionAxis: boolean;
}

// ── Optional capability blocks ───────────────────────
// Mirror of the shapes in `scripts/manifests/types.ts`. All optional; absent
// blocks resolve to safe defaults via the canonical `resolveCapabilities()`
// (exposed through `getManifestModule()` below).

export type ToolRunVarWhen = 'sectionAxis' | 'always';

export interface ToolRunVar {
  readonly name: string;
  readonly when: ToolRunVarWhen;
}

export interface ToolRunCapability {
  readonly vars?: readonly ToolRunVar[];
  readonly headlessVar?: string;
}

export interface ToolReportsCapability {
  readonly resultGlob?: string;
  readonly kind?: string;
}

export interface ToolTagsCapability {
  readonly strategy?: string;
}

/** Known tag-discovery strategies; unknown/absent resolve to `'none'`. */
export type ToolTagsStrategy = 'playwright-list' | 'robot-files' | 'none';

export interface ResolvedRunCapability {
  readonly vars: readonly ToolRunVar[];
  readonly headlessVar: string | null;
}

export interface ResolvedReportsCapability {
  readonly resultGlob: string;
  readonly kind: string | null;
}

export interface ResolvedTagsCapability {
  readonly strategy: ToolTagsStrategy;
}

export interface ResolvedCapabilities {
  readonly run: ResolvedRunCapability;
  readonly reports: ResolvedReportsCapability;
  readonly tags: ResolvedTagsCapability;
}

/**
 * Neutral run context the command-builder maps a `RunRequest` onto before
 * delegating to the canonical `buildRunCommandFromInput()` in
 * `scripts/manifests/runner-command.ts`. Mirror of the shared
 * `RunCommandInput`. `quote` escapes task-var values for safe shell pass-through.
 */
export interface RunCommandInput {
  readonly mode: 'local' | 'docker';
  readonly type?: string;
  readonly project?: string;
  readonly tag?: string;
  readonly section?: string;
  readonly performanceType?: string;
  readonly headless?: boolean;
  readonly extraArgs?: string;
  readonly quote: (value: string) => string;
}

export interface ToolManifest {
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
  readonly docker: { readonly baseImage: string };
  // Optional capability blocks; absent ⇒ safe defaults.
  readonly run?: ToolRunCapability;
  readonly reports?: ToolReportsCapability;
  readonly tags?: ToolTagsCapability;
}

export interface ManifestError {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface ToolManifestRecord {
  readonly path: string;
  readonly status: 'ok' | 'invalid' | 'disabled';
  readonly manifest: ToolManifest | null;
  readonly errors: readonly ManifestError[];
}

export interface ManifestRegistry {
  all(): readonly ToolManifestRecord[];
  enabled(): readonly ToolManifest[];
  byId(id: string): ToolManifest | undefined;
  refresh(): Promise<void>;
}

export interface ValidateManifestResult {
  readonly ok: boolean;
  readonly manifest?: ToolManifest;
  readonly errors?: readonly ManifestError[];
}

export interface ToolRegistryEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly gitUrl: string;
  readonly ref: string;
  readonly manifestPath?: string;
  readonly compatibleWith?: string;
}

export interface ToolRegistry {
  readonly $schema?: string;
  readonly schemaVersion: '1';
  readonly tools: readonly ToolRegistryEntry[];
}

export interface ManifestModule {
  createManifestRegistry: (workspaceRoot: string) => ManifestRegistry;
  setToolEnabled: (
    registry: ManifestRegistry,
    id: string,
    enabled: boolean,
  ) => Promise<ToolManifestRecord>;
  listProjectDirs: (toolDir: string, cfg: ToolProjectsConfig) => string[];
  loadToolRegistry: (workspaceRoot: string) => Promise<ToolRegistry>;
  validateManifest: (input: unknown) => ValidateManifestResult;
  resolveCapabilities: (manifest: ToolManifest) => ResolvedCapabilities;
  buildRunCommandFromInput: (manifest: ToolManifest, input: RunCommandInput) => string;
}

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
