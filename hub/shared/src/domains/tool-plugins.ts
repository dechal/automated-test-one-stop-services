// ============================================================================
// Tool Plugins — marketplace, lifecycle, and registry types
// ============================================================================

/** Status of a tool in the workspace. */
export type ToolStatus = 'enabled' | 'disabled' | 'broken';

/** Shape returned by GET /api/tools — one entry per discovered manifest. */
export interface ToolView {
  readonly id: string;
  readonly alias: string;
  readonly title: string;
  readonly description: string;
  readonly version: string;
  readonly status: ToolStatus;
  readonly runtime: 'node' | 'python' | 'binary';
  readonly packageManager: 'pnpm' | 'uv' | 'none';
  /** Number of non-template projects under tools/<id>/projects/. */
  readonly projectCount: number;
  /** Path of the manifest, relative to workspace root. */
  readonly manifestPath: string;
  /** Validation errors (empty when status !== 'broken'). */
  readonly errors: readonly { readonly code: string; readonly message: string }[];
  /** Where this tool was sourced from. */
  readonly origin: 'local' | 'registry' | 'unknown';
  readonly originRef?: string;
  /** Project layout from the manifest — drives the Create/Clone type axis. */
  readonly projects: {
    readonly depth: 1 | 2;
    readonly typeAxis: boolean;
    readonly fixedType: string | null;
    readonly root: string;
    readonly sectionAxis: boolean;
  };
  readonly capabilities: ToolCapabilitiesView;
}

export type ToolTagsStrategy = 'playwright-list' | 'robot-files' | 'none';

export interface ToolCapabilitiesView {
  readonly tagsStrategy: ToolTagsStrategy;
  readonly reportKind: string | null;
  readonly resultGlob: string;
  readonly runVars: readonly string[];
  readonly supportsHeadless: boolean;
}

/** Shape for the marketplace registry entries (GET /api/tool-registry). */
export interface ToolRegistryView {
  readonly entries: readonly {
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly gitUrl: string;
    readonly ref: string;
    readonly installed: boolean;
  }[];
}

/**
 * Generic wrapper for mutation responses that trigger the workspace re-sync hook.
 * Every lifecycle endpoint (enable/disable/install/uninstall/update) returns this shape.
 */
export interface LifecycleResult<T> {
  readonly result: T;
  readonly resynced: boolean;
  readonly regeneratedFiles: readonly string[];
  /** Populated when the lifecycle change applied but re-sync failed. */
  readonly resyncError?: { readonly code: string; readonly message: string };
  /**
   * Populated when wiring succeeded but installing the tool's own dependencies
   * (`pnpm install` / `uv sync`) failed. The clone is never rolled back when this
   * is set — the recovery is to fix the cause and re-run install.
   */
  readonly depsError?: { readonly code: string; readonly message: string };
  /**
   * Populated when dependencies installed but the tool's own `setup` task
   * (the Post_Install_Hook) failed. Exactly like `depsError`, the clone is never
   * rolled back when this is set — recovery is to fix the cause and re-run
   *. Absent when the tool defines no `setup` task.
   */
  readonly postInstallError?: { readonly code: string; readonly message: string };
}

/**
 * Result of `POST /api/tools/:id/provision` — (re-)runs the tool's `setup` task
 * (the Post_Install_Hook) to provision its browsers/binary. `ok` is `true` when
 * the task succeeds, or when the tool defines no `setup` task (no-op). On failure
 * `postInstallError` carries the cause so the UI can render actionable guidance
 * instead of a raw error dump. Mirrors `LifecycleResult.postInstallError`.
 */
export interface ProvisionResult {
  readonly ok: boolean;
  readonly postInstallError?: { readonly code: string; readonly message: string };
}

/** Preview shown during the two-phase install flow before user confirms. */
export interface ManifestPreview {
  readonly kind: 'preview';
  readonly id: string;
  readonly alias: string;
  readonly title: string;
  readonly version: string;
  readonly runtime: 'node' | 'python' | 'binary';
  readonly packageManager: 'pnpm' | 'uv' | 'none';
  readonly projects: { readonly depth: 1 | 2; readonly typeAxis: boolean };
  readonly dockerBaseImage: string;
  /** Repo cloned to this temp-style path; will be removed if user cancels. */
  readonly clonedAt: string;
}
