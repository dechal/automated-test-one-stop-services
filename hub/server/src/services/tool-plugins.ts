import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  LifecycleResult,
  ManifestPreview,
  ToolCapabilitiesView,
  ToolStatus,
  ToolView,
} from '@hub/shared';
import { TOOLS_DIR, WORKSPACE_ROOT } from '../config.js';
import { SAFE_GIT_REF, SAFE_ID } from '../lib/safe-id.js';
import {
  getManifestModule,
  getRegistry,
  invalidateManifestRegistry,
  type ManifestError,
  type ResolvedCapabilities,
  type ToolManifest,
  type ValidateManifestResult,
} from './manifest-registry.js';
import { invalidateProjectCache } from './scanner.js';
import { withResync } from './workspace-sync.js';

// ─── Dependency install ──────────────────────────────────────────────────────

/** Max wall-clock time for a tool's dependency install before we abort it. */
const DEPS_INSTALL_TIMEOUT_MS = 180_000;

/** Structured failure shape surfaced on `LifecycleResult.depsError`. */
export type DepsError = { readonly code: string; readonly message: string };

/**
 * Extract a useful message from a failed `execSync` call. With `stdio: 'pipe'`
 * the captured stderr lives on `err.stderr`; fall back to the error message.
 */
function extractDepsErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    const stderr = (err as { stderr?: Buffer | string | null }).stderr;
    if (stderr) {
      const text = stderr.toString().trim();
      if (text.length > 0) return text;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Install the freshly-wired tool's own dependencies.
 *
 * - `pnpm` -> `pnpm install --ignore-workspace` INSIDE `tools/<id>/` so the tool
 * resolves its deps into its own `tools/<id>/node_modules` + `pnpm-lock.yaml`
 * (both git-ignored). `--ignore-workspace` keeps it independent of the parent
 * workspace, so installing a portable tool never dirties the root
 * `pnpm-lock.yaml`. (`tools/*` is intentionally NOT a member of the root
 * pnpm workspace — see `pnpm-workspace.yaml`.)
 * - `uv` -> `uv sync` at the workspace root. uv tools (e.g. Robot Framework)
 * declare `automated-test-one-stop-service = { workspace = true }`, so they
 * remain root uv-workspace members and are synced from the root.
 * - `none` -> skip
 *
 * Commands are fixed constants (no tool-supplied interpolation), run with a
 * timeout, `stdio: 'pipe'`, and `windowsHide`. On failure the stderr is returned
 * as a structured `DepsError`; the caller surfaces it on `LifecycleResult.depsError`
 * and never rolls back the clone.
 */
function installToolDependencies(
  toolId: string,
  packageManager: ToolManifest['packageManager'],
): DepsError | undefined {
  if (packageManager === 'none') return undefined;

  const isPnpm = packageManager === 'pnpm';
  const command = isPnpm ? 'pnpm install --ignore-workspace' : 'uv sync';
  const cwd = isPnpm ? path.join(TOOLS_DIR, toolId) : WORKSPACE_ROOT;
  try {
    execSync(command, {
      cwd,
      stdio: 'pipe',
      timeout: DEPS_INSTALL_TIMEOUT_MS,
      windowsHide: true,
    });
    return undefined;
  } catch (err) {
    return { code: 'DEPS_INSTALL_FAILED', message: extractDepsErrorMessage(err) };
  }
}

// ─── Post-install hook (Post_Install_Hook) ────────────────────────

/** Max wall-clock time for a tool's `setup` task (mirrors DEPS_INSTALL_TIMEOUT_MS). */
const POST_INSTALL_TIMEOUT_MS = 180_000;

/**
 * Structured failure shape surfaced on `LifecycleResult.postInstallError`.
 * Mirrors {@link DepsError}; the clone is never rolled back when this is set.
 */
export type PostInstallError = { readonly code: 'POST_INSTALL_FAILED'; readonly message: string };

/** Outcome of running a tool's `setup` task: its exit code plus any captured stderr. */
export interface ToolSetupRun {
  readonly exitCode: number;
  readonly stderr: string;
}

/**
 * Injectable effects for the Post_Install_Hook: a folder-presence probe for the
 * tool's `setup` task and a runner returning that task's exit code + stderr.
 * Factoring these out keeps {@link runPostInstallHook} and
 * {@link resolveConfirmPhaseErrors} pure and property-testable
 * with a fake probe + fake runner — no real `task` spawn. The real effects are
 * built by {@link defaultPostInstallEffects}.
 */
export interface PostInstallHookEffects {
  readonly hasSetupTask: (toolId: string) => boolean;
  readonly runSetup: (toolId: string) => ToolSetupRun;
}

/**
 * Pure Post_Install_Hook result shaping. Given the injected effects:
 * - a tool that defines no `setup` task → no-op, no error; the runner
 * is never invoked;
 * - otherwise the `setup` task runs and a non-zero exit becomes a
 * `postInstallError`. The clone is never rolled back here —
 * this function only computes an error value, exactly like the `depsError` path.
 */
export function runPostInstallHook(
  toolId: string,
  effects: PostInstallHookEffects,
): PostInstallError | undefined {
  if (!effects.hasSetupTask(toolId)) return undefined;
  const { exitCode, stderr } = effects.runSetup(toolId);
  if (exitCode === 0) return undefined;
  const detail =
    stderr.trim().length > 0 ? stderr.trim() : `setup task exited with code ${exitCode}`;
  return {
    code: 'POST_INSTALL_FAILED',
    message: `Tool '${toolId}' Post_Install_Hook failed: ${detail}`,
  };
}

/**
 * Pure confirm-phase error overlay. Dependency install is a
 * prerequisite for the hook, so when `depsError` is set the hook does NOT run and
 * only `depsError` is surfaced; on a clean deps install the hook runs (after deps)
 * and may surface a `postInstallError`. The clone lives on `LifecycleResult.result`
 * and is never touched here — both error fields are pure overlays.
 */
export function resolveConfirmPhaseErrors(
  toolId: string,
  depsError: DepsError | undefined,
  effects: PostInstallHookEffects,
): { depsError?: DepsError; postInstallError?: PostInstallError } {
  if (depsError) return { depsError };
  const postInstallError = runPostInstallHook(toolId, effects);
  return postInstallError ? { postInstallError } : {};
}

/**
 * Probe whether `tools/<id>/Taskfile.yml` defines a top-level `setup:` task.
 *
 * Cross-link: mirrors `taskfileHasSetupTask` in `scripts/manifests/setup-planner.ts`
 * EXACTLY (a two-space-indented `setup:` key — the repo's go-task convention).
 * Replicated in-server rather than imported because the Hub reaches `scripts/`
 * only through the dynamic-import seam in `manifest-registry.ts`, which is outside
 * this change's scope; the probe is a fixed regex with no tool-supplied input, so
 * the copy stays in lock-step.
 */
function taskfileDefinesSetup(taskfilePath: string): boolean {
  try {
    return /\n {2}setup:/.test(fs.readFileSync(taskfilePath, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Run a tool's `setup` task (the real Post_Install_Hook spawn), returning its
 * exit code + captured stderr.
 *
 * Cross-link: the command mirrors
 * `buildToolSetupInvocation` in `scripts/install-core/invocation.ts` EXACTLY —
 * `task --taskfile tools/<id>/Taskfile.yml --dir tools/<id> setup`. The executable,
 * flags, and subcommand are fixed constants; the ONLY variable parts are the two
 * `tools/<id>` path slots, and `<id>` is SAFE_ID-validated (defence-in-depth
 * re-guard below) so no tool-supplied string is interpolated into the shell.
 * Mirrors `installToolDependencies`' spawn pattern (`execSync`, timeout,
 * `stdio: 'pipe'`, `windowsHide`).
 */
function runToolSetupTask(toolId: string): ToolSetupRun {
  // The id is already SAFE_ID-validated upstream (installFromRegistry); re-guard
  // defensively so an unsafe value can never reach the command slot.
  if (!SAFE_ID.test(toolId)) {
    return { exitCode: 1, stderr: `'${toolId}' is not a valid tool name` };
  }
  try {
    execSync(`task --taskfile tools/${toolId}/Taskfile.yml --dir tools/${toolId} setup`, {
      cwd: WORKSPACE_ROOT,
      stdio: 'pipe',
      timeout: POST_INSTALL_TIMEOUT_MS,
      windowsHide: true,
    });
    return { exitCode: 0, stderr: '' };
  } catch (err) {
    const status = (err as { status?: number | null }).status;
    return {
      exitCode: typeof status === 'number' ? status : 1,
      stderr: extractDepsErrorMessage(err),
    };
  }
}

/**
 * The real Post_Install_Hook effects rooted at `tools/`: folder-presence probe +
 * fixed-constant `task ... setup` spawn. Injected by the confirm phase; tests pass
 * fakes instead so they never spawn or read the filesystem.
 */
export function defaultPostInstallEffects(): PostInstallHookEffects {
  return {
    hasSetupTask: (toolId) => taskfileDefinesSetup(path.join(TOOLS_DIR, toolId, 'Taskfile.yml')),
    runSetup: (toolId) => runToolSetupTask(toolId),
  };
}

// ─── Origin detection ────────────────────────────────────────────────────────

function detectOrigin(toolId: string): { origin: ToolView['origin']; originRef?: string } {
  const toolGitDir = path.join(TOOLS_DIR, toolId, '.git');
  if (fs.existsSync(toolGitDir)) {
    return { origin: 'registry' };
  }
  return { origin: 'local' };
}

// ─── Validation helpers ──────────────────────────────────────────────────────

/**
 * SAFE_GIT_URL: validates git URLs to prevent injection.
 * Accepts https://, ssh://git@, or git@host:path forms.
 */
const SAFE_GIT_URL = /^(?:https:\/\/|ssh:\/\/git@|git@)[A-Za-z0-9._:/~@?=+-]+(?:\.git)?$/;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * List all discovered tools as `ToolView[]` — the shape consumed by
 * `GET /api/tools`. Computes `projectCount` per tool from `listProjectDirs()`
 * excluding `*-template-example` folders.
 */
export async function listToolViews(): Promise<readonly ToolView[]> {
  const reg = await getRegistry();
  const mod = await getManifestModule();
  const records = reg.all();

  return records.map((record): ToolView => {
    if (record.manifest === null) {
      // Broken manifest — surface errors without crashing
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
        manifestPath: path.relative(WORKSPACE_ROOT, record.path),
        errors: record.errors.map((e) => ({ code: e.code, message: e.message })),
        projects: {
          depth: 2,
          typeAxis: false,
          fixedType: null,
          root: 'projects',
          sectionAxis: false,
        },
        capabilities: BROKEN_TOOL_CAPABILITIES,
        ...detectOrigin(id),
      };
    }

    const manifest = record.manifest;
    const toolDir = path.join(TOOLS_DIR, manifest.id);
    const projectCount = mod.listProjectDirs(toolDir, manifest.projects).length;
    const status: ToolStatus = record.status === 'ok' ? 'enabled' : 'disabled';

    return {
      id: manifest.id,
      alias: manifest.alias,
      title: manifest.title,
      description: manifest.description,
      version: manifest.version,
      status,
      runtime: manifest.runtime,
      packageManager: manifest.packageManager,
      projectCount,
      manifestPath: path.relative(WORKSPACE_ROOT, record.path),
      errors: [],
      projects: {
        depth: manifest.projects.depth,
        typeAxis: manifest.projects.typeAxis,
        fixedType: manifest.projects.fixedType,
        root: manifest.projects.root,
        sectionAxis: manifest.projects.sectionAxis,
      },
      capabilities: toCapabilitiesView(mod.resolveCapabilities(manifest)),
      ...detectOrigin(manifest.id),
    };
  });
}

const BROKEN_TOOL_CAPABILITIES: ToolCapabilitiesView = {
  tagsStrategy: 'none',
  reportKind: null,
  resultGlob: '**/*.html',
  runVars: [],
  supportsHeadless: false,
};

function toCapabilitiesView(resolved: ResolvedCapabilities): ToolCapabilitiesView {
  return {
    tagsStrategy: resolved.tags.strategy as ToolCapabilitiesView['tagsStrategy'],
    reportKind: resolved.reports.kind,
    resultGlob: resolved.reports.resultGlob,
    runVars: resolved.run.vars.map((v) => v.name),
    supportsHeadless: resolved.run.headlessVar !== null,
  };
}

/**
 * Enable or disable a tool. Two scopes:
 * - `'commit'`: writes `manifest.enabled` directly in `tool.manifest.json`
 * - `'local'`: writes to `config/.tool-overrides.json` (gitignored, no commit)
 *
 * After mutation, invalidates the scanner cache so `/api/projects` reflects
 * the new state immediately.
 */
export async function setEnabled(
  id: string,
  enabled: boolean,
  scope: 'commit' | 'local',
): Promise<LifecycleResult<ToolView>> {
  const reg = await getRegistry();
  const mod = await getManifestModule();

  if (scope === 'local') {
    writeLocalOverride(id, enabled);
    await reg.refresh();
  } else {
    await mod.setToolEnabled(reg, id, enabled);
  }

  invalidateProjectCache();

  // Return updated ToolView for this tool
  const views = await listToolViews();
  const updated = views.find((v) => v.id === id);
  if (!updated) {
    throw new Error(`Tool ${id} not found after setEnabled`);
  }

  return {
    result: updated,
    resynced: false,
    regeneratedFiles: [],
  };
}

/**
 * Refresh the registry cache (re-scan disk, re-validate) and return counts.
 */
export async function refreshAndCount(): Promise<{
  enabled: number;
  disabled: number;
  invalid: number;
}> {
  const reg = await getRegistry();
  await reg.refresh();
  invalidateProjectCache();

  const records = reg.all();
  let enabled = 0;
  let disabled = 0;
  let invalid = 0;
  for (const r of records) {
    if (r.status === 'ok') enabled++;
    else if (r.status === 'disabled') disabled++;
    else invalid++;
  }

  return { enabled, disabled, invalid };
}

// ─── Uninstall types ─────────────────────────────────────────────────────────

export interface UninstallConflict {
  readonly code: 'TOOL_HAS_PROJECTS';
  readonly tool: string;
  readonly projectCount: number;
  readonly projects: readonly string[];
}

// ─── Transactional remove ────────────────────────────────────────────────────

/**
 * Atomically remove a directory using a rename-to-quarantine strategy:
 * 1. Rename `dir` → `tools/.quarantine-<id>-<timestamp>`
 * 2. `rm -rf` quarantine
 * On rename/remove failure: rename back to original path and throw.
 */
async function transactionalRemove(dir: string): Promise<void> {
  const toolId = path.basename(dir);
  const quarantine = path.join(TOOLS_DIR, `.quarantine-${toolId}-${Date.now()}`);

  // Step 1: rename into quarantine
  try {
    fs.renameSync(dir, quarantine);
  } catch (err) {
    throw new Error(
      `Failed to quarantine tool directory: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Step 2: remove quarantine
  try {
    fs.rmSync(quarantine, { recursive: true, force: true });
  } catch (err) {
    // Attempt to restore from quarantine
    try {
      fs.renameSync(quarantine, dir);
    } catch {
      // Best-effort restore failed — still throw the original error
    }
    throw new Error(
      `Failed to remove quarantined directory: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Python pyproject.toml workspace member revert ───────────────────────────

const PYPROJECT_PATH = path.join(WORKSPACE_ROOT, 'pyproject.toml');

/**
 * Remove a tool's entry from `[tool.uv.workspace]` members in pyproject.toml.
 * Only acts when the manifest declares `packageManager === 'uv'` and the entry
 * actually exists. The edit is idempotent — calling it when no entry exists is
 * a no-op.
 */
function revertPyprojectMember(toolId: string): void {
  if (!fs.existsSync(PYPROJECT_PATH)) return;

  const content = fs.readFileSync(PYPROJECT_PATH, 'utf8');
  const memberEntry = `"tools/${toolId}"`;

  // Check if the entry actually exists in the members array
  if (!content.includes(memberEntry)) return;

  // Remove the member entry line (handles both trailing comma and no comma)
  const lines = content.split('\n');
  const updated = lines
    .filter((line) => {
      const trimmed = line.trim();
      // Match lines like: "tools/<id>", or "tools/<id>"
      return !(trimmed === memberEntry || trimmed === `${memberEntry},`);
    })
    .join('\n');

  fs.writeFileSync(PYPROJECT_PATH, updated, 'utf8');
}

// ─── Public uninstall API ────────────────────────────────────────────────────

/**
 * Uninstall a tool by physically removing `tools/<id>/`.
 *
 * Preconditions:
 * - The tool must exist (manifest found).
 * - No non-template projects may exist under the tool (project-count guard).
 * - There is NO `force=true` escape hatch — callers must remove projects first.
 *
 * On success: transactionally removes the tool directory, reverts any
 * `[tool.uv.workspace]` pyproject.toml entry for Python tools, invalidates
 * caches, and runs `withResync(...)`.
 */
export async function uninstall(
  id: string,
): Promise<UninstallConflict | LifecycleResult<{ removed: string }>> {
  const reg = await getRegistry();
  const mod = await getManifestModule();
  const manifest = reg.byId(id);

  if (!manifest) {
    throw new Error(`Tool '${id}' not found`);
  }

  // Project-count guard — refuse when non-template projects exist
  const toolDir = path.join(TOOLS_DIR, manifest.id);
  const projects = mod.listProjectDirs(toolDir, manifest.projects);

  if (projects.length > 0) {
    return {
      code: 'TOOL_HAS_PROJECTS',
      tool: manifest.id,
      projectCount: projects.length,
      projects,
    };
  }

  // For Python tools: revert pyproject.toml workspace member before removal
  if (manifest.packageManager === 'uv') {
    revertPyprojectMember(manifest.id);
  }

  // Transactional removal + cache invalidation + re-sync
  return withResync(async () => {
    await transactionalRemove(toolDir);
    invalidateProjectCache();
    invalidateManifestRegistry(); // force registry re-creation on next access
    return { removed: manifest.id };
  });
}

// ─── Two-phase install service ─────────────────────────────────────────

/** Options for the two-phase install flow. */
export interface InstallOpts {
  /** Phase 2: confirm installation after preview. */
  readonly confirm?: boolean;
  /** Phase 2 alt: abort installation, remove cloned folder. */
  readonly abort?: boolean;
  /** When true AND tool runtime is python, append [tool.uv.workspace] entry. */
  readonly editPyproject?: boolean;
}

/** Returned when manifest validation fails during phase 1. */
export interface InstallInvalidManifestError {
  readonly code: 'INVALID_MANIFEST';
  readonly errors: readonly ManifestError[];
}

/** Returned when git clone fails during phase 1. */
export interface InstallCloneFailedError {
  readonly code: 'CLONE_FAILED';
  readonly message: string;
}

/** Returned when the registry entry is not found. */
export interface InstallRegistryNotFoundError {
  readonly code: 'REGISTRY_NOT_FOUND';
  readonly message: string;
}

/** Returned when the tool name fails SAFE_ID validation. */
export interface InstallInvalidNameError {
  readonly code: 'INVALID_TOOL_NAME';
  readonly message: string;
}

/** Returned when the registry entry has an unsafe git URL. */
export interface InstallInvalidGitUrlError {
  readonly code: 'INVALID_GIT_URL';
  readonly message: string;
}

/** Returned when install is aborted by the user. */
export interface InstallAbortedResult {
  readonly aborted: true;
}

/** Returned when the tool folder already exists. */
export interface InstallDuplicateToolError {
  readonly code: 'DUPLICATE_TOOL';
  readonly message: string;
}

/** Union of all possible install error shapes. */
export type InstallError =
  | InstallInvalidManifestError
  | InstallCloneFailedError
  | InstallRegistryNotFoundError
  | InstallInvalidNameError
  | InstallInvalidGitUrlError
  | InstallDuplicateToolError;

/** Union of all possible install results across both phases. */
export type InstallResult =
  | ManifestPreview
  | LifecycleResult<ToolView>
  | InstallAbortedResult
  | InstallError;

/**
 * Two-phase install from the workspace tool registry.
 *
 * Phase 1 (no `confirm`/`abort`):
 * Clone the registry entry's repo, validate the manifest.
 * - Valid → return `ManifestPreview`
 * - Invalid manifest → rm -rf cloned folder, return `INVALID_MANIFEST`
 * - Clone failure → return `CLONE_FAILED`
 *
 * Phase 2 (`confirm: true`):
 * Invalidate caches, run workspace re-sync, return `LifecycleResult<ToolView>`.
 *
 * Phase 2 alt (`abort: true`):
 * Remove the cloned folder, return `{ aborted: true }`.
 *
 * Python tools: the `[tool.uv.workspace]` pyproject.toml edit is gated behind
 * `opts.editPyproject` — it is NOT auto-applied. The install confirmation dialog
 * must surface this as an explicit checkbox.
 */
export async function installFromRegistry(
  name: string,
  opts: InstallOpts = {},
): Promise<InstallResult> {
  // ── Validate name against SAFE_ID ──────────────────────────────────────────
  if (!SAFE_ID.test(name)) {
    return { code: 'INVALID_TOOL_NAME', message: `'${name}' is not a valid tool name` };
  }

  const targetDir = path.join(TOOLS_DIR, name);

  // ── Phase 2 alt: abort ─────────────────────────────────────────────────────
  if (opts.abort) {
    safelyRemoveDir(targetDir);
    return { aborted: true };
  }

  // ── Phase 2: confirm ───────────────────────────────────────────────────────
  if (opts.confirm) {
    // Apply pyproject.toml edit for Python tools if consented
    if (opts.editPyproject) {
      const manifestPath = path.join(targetDir, 'tool.manifest.json');
      if (fs.existsSync(manifestPath)) {
        const raw = fs.readFileSync(manifestPath, 'utf8');
        const parsed = JSON.parse(raw) as { runtime?: string };
        if (parsed.runtime === 'python') {
          appendPyprojectWorkspaceEntry(name);
        }
      }
    }

    const result = await withResync<ToolView>(async () => {
      const reg = await getRegistry();
      await reg.refresh();
      invalidateProjectCache();

      const views = await listToolViews();
      const installed = views.find((v) => v.id === name);
      if (!installed) {
        throw new Error(`Tool '${name}' not found after install confirmation`);
      }
      return installed;
    });

    // Install the tool's own dependencies AFTER wiring. A failure
    // surfaces as `depsError` and never rolls back the clone; a tool with
    // `packageManager: 'none'` still succeeds.
    const depsError = installToolDependencies(name, result.result.packageManager);

    // Run the tool's `setup` task as the Post_Install_Hook immediately after deps
    //. Deps are a prerequisite, so a `depsError` skips the hook; a hook
    // failure surfaces as `postInstallError`. Either error keeps the
    // clone in place — both are pure overlays, never a rollback.
    const errors = resolveConfirmPhaseErrors(name, depsError, defaultPostInstallEffects());
    return { ...result, ...errors };
  }

  // ── Phase 1: clone + validate ──────────────────────────────────────────────

  // Look up the registry entry
  const mod = await getManifestModule();
  const toolRegistry = await mod.loadToolRegistry(WORKSPACE_ROOT);
  const entry = toolRegistry.tools.find((e) => e.name === name);
  if (!entry) {
    return { code: 'REGISTRY_NOT_FOUND', message: `'${name}' is not in the tool registry` };
  }

  // Validate git URL
  if (!SAFE_GIT_URL.test(entry.gitUrl)) {
    return {
      code: 'INVALID_GIT_URL',
      message: `Registry entry '${name}' has an unsafe git URL`,
    };
  }

  // Refuse if the folder already exists (avoid overwriting)
  if (fs.existsSync(targetDir)) {
    return {
      code: 'DUPLICATE_TOOL',
      message: `tools/${name} already exists; uninstall first`,
    };
  }

  // Clone the repository
  try {
    execSync(buildGitCloneCommand(entry.gitUrl, entry.ref, targetDir), {
      stdio: 'pipe',
      timeout: 60_000,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Clean up partial clone if anything landed on disk
    safelyRemoveDir(targetDir);
    return { code: 'CLONE_FAILED', message };
  }

  // Validate the cloned manifest
  const manifestPath = path.join(targetDir, entry.manifestPath ?? 'tool.manifest.json');
  if (!fs.existsSync(manifestPath)) {
    safelyRemoveDir(targetDir);
    return {
      code: 'INVALID_MANIFEST',
      errors: [
        {
          code: 'IO_ERROR',
          message: `Manifest not found at ${entry.manifestPath ?? 'tool.manifest.json'}`,
        },
      ],
    };
  }

  let manifestRaw: string;
  try {
    manifestRaw = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    safelyRemoveDir(targetDir);
    const message = err instanceof Error ? err.message : String(err);
    return {
      code: 'INVALID_MANIFEST',
      errors: [{ code: 'IO_ERROR', message }],
    };
  }

  let manifestParsed: unknown;
  try {
    manifestParsed = JSON.parse(manifestRaw);
  } catch (err) {
    safelyRemoveDir(targetDir);
    const message = err instanceof Error ? err.message : String(err);
    return {
      code: 'INVALID_MANIFEST',
      errors: [{ code: 'SCHEMA_FAIL', message: `Invalid JSON: ${message}` }],
    };
  }

  const validationResult = mod.validateManifest(manifestParsed);
  if (!validationResult.ok) {
    safelyRemoveDir(targetDir);
    return {
      code: 'INVALID_MANIFEST',
      errors: validationResult.errors ?? [],
    };
  }

  // Manifest is valid — return a preview
  const manifest = validationResult.manifest as ToolManifest;
  const preview: ManifestPreview = {
    kind: 'preview',
    id: manifest.id,
    alias: manifest.alias,
    title: manifest.title,
    version: manifest.version,
    runtime: manifest.runtime,
    packageManager: manifest.packageManager,
    projects: {
      depth: manifest.projects.depth,
      typeAxis: manifest.projects.typeAxis,
    },
    dockerBaseImage: manifest.docker.baseImage,
    clonedAt: targetDir,
  };

  return preview;
}

// ─── Tool Update ────────────────────────────────────────────────────────

/** Error shape returned by `updateTool` when the operation cannot proceed. */
export interface UpdateToolError {
  readonly code:
    | 'NOT_REGISTRY_INSTALLED'
    | 'LOCAL_EDITS_PRESENT'
    | 'INVALID_MANIFEST_AFTER_UPDATE'
    | 'INVALID_REF'
    | 'INVALID_TOOL_NAME';
  readonly message: string;
  readonly dirty?: readonly string[];
  readonly errors?: readonly { readonly code: string; readonly message: string }[];
}

/** Discriminated result: either a lifecycle success or a structured error. */
export type UpdateToolResult =
  | { readonly ok: true; readonly lifecycle: LifecycleResult<{ from: string; to: string }> }
  | { readonly ok: false; readonly error: UpdateToolError };

/**
 * Update a registry-installed tool to a newer git ref.
 *
 * Refuses to operate on tools with no `.git/` directory (not registry-installed)
 * and refuses to throw away local edits (dirty working tree).
 *
 * On success: invalidates caches, runs the workspace re-sync hook, and returns
 * `LifecycleResult<{ from, to }>` with the previous and new commit SHAs.
 */
export async function updateTool(id: string, ref?: string): Promise<UpdateToolResult> {
  // Defence in depth: `id` is interpolated into `git -C "${toolDir}"` shell
  // strings below, so re-guard it against the safe-id charset (sibling entry
  // points like runToolSetupTask/installFromRegistry do the same) before any
  // git work.
  if (!SAFE_ID.test(id)) {
    return {
      ok: false,
      error: { code: 'INVALID_TOOL_NAME', message: `tool "${id}" contains unsafe characters` },
    };
  }
  // Defence in depth: the route validates `ref` too, but `targetRef` is
  // interpolated into a `git` shell command below, so re-guard here against the
  // safe ref charset before any git work.
  if (ref !== undefined && !SAFE_GIT_REF.test(ref)) {
    return {
      ok: false,
      error: { code: 'INVALID_REF', message: `ref "${ref}" contains unsafe characters` },
    };
  }

  const toolDir = path.join(TOOLS_DIR, id);
  const gitDir = path.join(toolDir, '.git');

  // Step 1: Verify this is a registry-installed tool (has .git/)
  if (!fs.existsSync(gitDir)) {
    return {
      ok: false,
      error: {
        code: 'NOT_REGISTRY_INSTALLED',
        message: `Tool "${id}" is not registry-installed (no .git directory)`,
      },
    };
  }

  // Step 2: Capture previous SHA for rollback/response
  const previousSHA = execSync(`git -C "${toolDir}" rev-parse HEAD`, {
    encoding: 'utf8',
  }).trim();

  // Step 3: Fetch latest from origin
  execSync(`git -C "${toolDir}" fetch origin`, { encoding: 'utf8', stdio: 'pipe' });

  // Step 4: Check for dirty working tree
  const porcelainOutput = execSync(`git -C "${toolDir}" status --porcelain`, {
    encoding: 'utf8',
  }).trim();

  if (porcelainOutput.length > 0) {
    const dirty = porcelainOutput
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter((f) => f.length > 0);
    return {
      ok: false,
      error: {
        code: 'LOCAL_EDITS_PRESENT',
        message: `Tool "${id}" has uncommitted local edits`,
        dirty,
      },
    };
  }

  // Step 5: Resolve target ref — request body `ref` overrides default branch
  const targetRef = ref ?? getDefaultBranch(toolDir);

  // Step 6: Checkout and pull (ff-only to avoid rewriting history)
  execSync(`git -C "${toolDir}" checkout ${targetRef}`, { encoding: 'utf8', stdio: 'pipe' });
  execSync(`git -C "${toolDir}" pull --ff-only`, { encoding: 'utf8', stdio: 'pipe' });

  // Step 7: Re-validate manifest after update
  const manifestPath = path.join(toolDir, 'tool.manifest.json');
  const mod = await getManifestModule();
  let validationResult: ValidateManifestResult;

  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    validationResult = mod.validateManifest(parsed);
  } catch (err) {
    validationResult = {
      ok: false,
      errors: [
        {
          code: 'SCHEMA_FAIL',
          message: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }

  // Step 8: On validation failure, rollback to previous SHA
  if (!validationResult.ok) {
    execSync(`git -C "${toolDir}" reset --hard ${previousSHA}`, {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return {
      ok: false,
      error: {
        code: 'INVALID_MANIFEST_AFTER_UPDATE',
        message: `Manifest validation failed after update; rolled back to ${previousSHA}`,
        errors: validationResult.errors ?? [],
      },
    };
  }

  // Step 9: Capture new SHA
  const newSHA = execSync(`git -C "${toolDir}" rev-parse HEAD`, {
    encoding: 'utf8',
  }).trim();

  // Step 10: Invalidate caches and run re-sync
  const lifecycle = await withResync(async () => {
    const reg = await getRegistry();
    await reg.refresh();
    invalidateProjectCache();
    return { from: previousSHA, to: newSHA };
  });
  return { ok: true, lifecycle };
}

/**
 * Determine the default branch of a git repository by inspecting the
 * symbolic-ref of origin/HEAD. Falls back to 'main' if not set.
 */
function getDefaultBranch(toolDir: string): string {
  try {
    const ref = execSync(`git -C "${toolDir}" symbolic-ref refs/remotes/origin/HEAD`, {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    // ref is like "refs/remotes/origin/main" — extract the branch name
    return ref.replace('refs/remotes/origin/', '');
  } catch {
    return 'main';
  }
}

// ─── Manual-clone deps install ──────────────────────────────────────

/** Returned when the tool id is not a known, enabled manifest. */
export interface InstallDepsToolNotFoundError {
  readonly code: 'TOOL_NOT_FOUND';
  readonly message: string;
}

/** Options for the manual-clone deps-install flow. */
export interface InstallDepsOpts {
  /** When true AND the tool runtime is python, append [tool.uv.workspace] entry. */
  readonly editPyproject?: boolean;
}

/** Union of all possible deps-install results. */
export type InstallDepsResult = InstallResult | InstallDepsToolNotFoundError;

/**
 * Wire + install dependencies for a manually-cloned tool.
 *
 * Discovery picks up any `tools/<id>/tool.manifest.json` on the next
 * registry refresh; this entry point lets a manually-cloned tool be wired into
 * the workspace and have its dependencies installed without going through the
 * registry-install flow. The tool's `origin` is reported as `'local'` when it
 * carries no registry `.git` marker (see {@link detectOrigin}).
 *
 * Validation order:
 * - invalid `id` → `INVALID_TOOL_NAME` (the route also guards this before FS/git)
 * - unknown / disabled tool → `TOOL_NOT_FOUND`
 *
 * The actual wiring + dependency install is delegated to the shared
 * confirm-phase entry point ({@link installFromRegistry} with `confirm: true`),
 * which runs inside `withResync` — no duplicated package-manager spawn logic.
 * The `[tool.uv.workspace]` pyproject edit stays gated behind `editPyproject`
 * consent, exactly like the registry-install flow.
 */
export async function installDepsForTool(
  id: string,
  opts: InstallDepsOpts = {},
): Promise<InstallDepsResult> {
  // Guard the id before any FS/git work (route validates too — defence in depth).
  if (!SAFE_ID.test(id)) {
    return { code: 'INVALID_TOOL_NAME', message: `'${id}' is not a valid tool name` };
  }

  // Re-scan disk so a freshly manual-cloned tool is discovered, then require it
  // to be a known, ENABLED manifest (byId also returns disabled tools).
  const reg = await getRegistry();
  await reg.refresh();
  const isEnabled = reg.enabled().some((m) => m.id === id);
  if (!isEnabled) {
    return { code: 'TOOL_NOT_FOUND', message: `Tool '${id}' is not a known enabled tool` };
  }

  return installFromRegistry(id, { confirm: true, editPyproject: opts.editPyproject });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Path of the local overrides file (gitignored). */
const OVERRIDES_PATH = path.join(WORKSPACE_ROOT, 'config', '.tool-overrides.json');

/**
 * Write a per-tool enabled override to `config/.tool-overrides.json`.
 * Creates the file if it doesn't exist; preserves other entries.
 */
function writeLocalOverride(id: string, enabled: boolean): void {
  let overrides: Record<string, { enabled?: boolean }> = {};
  if (fs.existsSync(OVERRIDES_PATH)) {
    try {
      const raw = fs.readFileSync(OVERRIDES_PATH, 'utf8');
      overrides = JSON.parse(raw) as Record<string, { enabled?: boolean }>;
    } catch {
      // Malformed file — reset to empty
      overrides = {};
    }
  }

  overrides[id] = { enabled };

  const dir = path.dirname(OVERRIDES_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(OVERRIDES_PATH, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8');
}

/**
 * Extract tool id from a manifest path. The manifest is always at
 * `tools/<id>/tool.manifest.json`, so the id is the parent folder name.
 */
function extractIdFromPath(manifestPath: string): string {
  return path.basename(path.dirname(manifestPath));
}

/**
 * Build a git clone command string. Uses array-style arguments conceptually,
 * but execSync needs a single string. The arguments are validated before
 * reaching this function (SAFE_ID for name, SAFE_GIT_URL for url).
 */
function buildGitCloneCommand(gitUrl: string, ref: string, targetDir: string): string {
  // All inputs have been validated by SAFE_GIT_URL and SAFE_ID before this point.
  // The ref is from the trusted registry file (committed to the repo).
  return `git clone "${gitUrl}" --branch "${ref}" --single-branch --depth 1 "${targetDir}"`;
}

/**
 * Safely remove a directory. Idempotent — does not throw if the path
 * doesn't exist. Logs a warning if removal fails.
 */
function safelyRemoveDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) return;
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`⚠ Failed to remove ${dirPath}: ${message}`);
  }
}

/**
 * Append a workspace member entry to pyproject.toml [tool.uv.workspace].
 * Only called when the user explicitly consents via `opts.editPyproject`.
 * Idempotent — skips if the entry already exists.
 */
function appendPyprojectWorkspaceEntry(toolName: string): void {
  if (!fs.existsSync(PYPROJECT_PATH)) return;

  const content = fs.readFileSync(PYPROJECT_PATH, 'utf8');
  const entry = `"tools/${toolName}"`;

  // Skip if already present
  if (content.includes(entry)) return;

  // Find the [tool.uv.workspace] members array and append
  const membersRegex = /(\[tool\.uv\.workspace\]\s*\nmembers\s*=\s*\[)([^\]]*)\]/;
  const match = membersRegex.exec(content);
  if (!match) {
    // [tool.uv.workspace] section not found — skip rather than corrupt the file
    console.error('⚠ [tool.uv.workspace] section not found in pyproject.toml; skipping edit');
    return;
  }

  const existingMembers = (match[2] ?? '').trim();
  const separator = existingMembers.length > 0 ? ',\n  ' : '\n  ';
  const updatedContent = content.replace(
    membersRegex,
    `${match[1]}${existingMembers}${separator}${entry}\n]`,
  );

  fs.writeFileSync(PYPROJECT_PATH, updatedContent, 'utf8');
}
