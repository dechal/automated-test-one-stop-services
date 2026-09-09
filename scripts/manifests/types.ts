// scripts/manifests/types.ts
//
// Canonical TypeScript shapes for the manifest layer.
// This is the single source of truth that every consumer (sync-projects,
// create-project, runner, pipeline.json, hub server, hub client) derives from.
// Two shapes live here: the tool manifest and the tool registry.

/**
 * Branded-string helper. Produces a nominal type so a plain `string` cannot be
 * assigned where a `ToolId` / `ToolAlias` is expected without an explicit cast.
 * Behaviourally identical to `type-fest`'s `Tagged`, declared locally to avoid
 * adding an extra dependency for a one-line utility.
 */
declare const tagSymbol: unique symbol;
export type Tagged<BaseType, Tag extends PropertyKey> = BaseType & {
  readonly [tagSymbol]: Tag;
};

/** Manifest schema version. Bump on breaking changes. */
export type ManifestSchemaVersion = '1';

/** Stable identifier; matches the folder name under tools/. */
export type ToolId = Tagged<string, 'ToolId'>;

/** Short alias used in `task <alias>:run-local`, e.g. 'pw'. */
export type ToolAlias = Tagged<string, 'ToolAlias'>;

export type ToolRuntime = 'node' | 'python' | 'binary';
export type ToolPackageManager = 'pnpm' | 'uv' | 'none';

export interface ToolProjectsConfig {
  /** Folder under tools/<id>/ holding projects. Default: 'projects'. */
  readonly root: string;
  /** Folder depth before reaching a project. 1 = root/<project>, 2 = root/<type>/<project>. */
  readonly depth: 1 | 2;
  /** True when the tool exposes a TYPE axis (web/api/desktop/...). */
  readonly typeAxis: boolean;
  /** When typeAxis is false, the implicit type slot value (e.g. 'performance' for k6). */
  readonly fixedType: string | null;
  /**
   * Template folder lookup. Key is the type (or 'default' when typeAxis is false).
   * Values are paths relative to tools/<id>/.
   */
  readonly templates: Readonly<Record<string, string>>;
  /** Subpath inside a project where specs live. Default: 'automations/specs'. */
  readonly specsSubdir: string;
  /** When true, projects expose a SECTION axis under specsSubdir (k6). */
  readonly sectionAxis: boolean;
}

export interface ToolComposeConfig {
  /** Template file relative to tools/<id>/. */
  readonly template: string;
  /** YAML anchor name in the template (e.g. 'playwright-template'). */
  readonly anchor: string;
  /** Names of external Docker networks to declare in the generated compose file. */
  readonly networks: readonly string[];
}

export interface ToolTsconfigGenConfig {
  readonly template: string;
  readonly output: string;
  /** Alias prefix in tsconfig paths, e.g. '~' produces '~ecom/*'. */
  readonly aliasPrefix: string;
  /** Path template; supports {type} and {project} placeholders. */
  readonly aliasTarget: string;
}

export interface ToolVersionSourceConfig {
  readonly file: string;
  readonly dependency: string;
}

export interface ToolDockerConfig {
  /** Base image with optional template tokens (e.g. {playwrightVersion}). */
  readonly baseImage: string;
  /** Apt/apk/pip extras the delivery agent installs on top of baseImage. */
  readonly extras: readonly string[];
}

/** Single declarative step in the runner prompt loop. */
export type ToolRunnerStep = ToolRunnerSelectDirsStep | ToolRunnerSelectStep | ToolRunnerTextStep;

interface ToolRunnerStepBase {
  readonly id: string;
  readonly when?: ToolRunnerWhen;
  readonly preAction?: string;
  readonly passAs: ToolRunnerPassAs;
  readonly dockerOverride?: string;
}

export interface ToolRunnerSelectDirsStep extends ToolRunnerStepBase {
  readonly kind: 'selectDirs';
  readonly from: string;
  readonly exclude?: string;
  readonly title: string;
}

export interface ToolRunnerSelectStep extends ToolRunnerStepBase {
  readonly kind: 'select';
  readonly title: string;
  readonly choices: readonly { readonly title: string; readonly value: string }[];
}

export interface ToolRunnerTextStep extends ToolRunnerStepBase {
  readonly kind: 'text';
  readonly title: string;
  readonly initial?: string;
}

export type ToolRunnerWhen = Readonly<{
  readonly [answerId: string]:
    | string
    | { readonly $ne: string }
    | { readonly $in: readonly string[] };
}>;

export type ToolRunnerPassAs =
  | { readonly kind: 'task'; readonly key: string }
  | { readonly kind: 'cli' }
  | { readonly kind: 'none' };

export interface ToolRunnerConfig {
  readonly taskNamespace: string;
  readonly title: string;
  readonly executionTypes: readonly {
    readonly id: string;
    readonly title: string;
    readonly commandTemplate: string;
  }[];
  readonly environments: readonly ('local' | 'docker')[];
  readonly steps: readonly ToolRunnerStep[];
  readonly commandTemplate: string;
}

export interface ToolPipelineConfig {
  readonly id: string;
  readonly targetPaths: Readonly<Record<string, string>>;
  readonly envToken: string;
  readonly runCommands: Readonly<Record<string, string>>;
  readonly artifactPaths: readonly string[];
}

// ── Optional capability blocks ───────────────────────
// All three blocks are OPTIONAL and additive; `schemaVersion` stays "1".
// An absent block resolves to a safe default via `resolveCapabilities()`
// (see validate.ts): no extra run vars, a generic `**/*.html` report glob, and
// `tags.strategy: 'none'`. This satisfies the "degrade, don't break" contract
// so an installed tool with no capability
// blocks is still runnable / report-viewable with safe generic behaviour.

/**
 * Gate controlling when a run var is emitted. `'sectionAxis'` emits the var
 * only for tools whose projects expose a section axis (e.g. k6 `SECTION`);
 * `'always'` emits it unconditionally (e.g. k6 `PERFORMANCE_TYPE`).
 */
export type ToolRunVarWhen = 'sectionAxis' | 'always';

/** A single tool-specific run variable declared by the manifest. */
export interface ToolRunVar {
  readonly name: string;
  readonly when: ToolRunVarWhen;
}

/**
 * Optional run-capability block. `vars` declares tool-specific run variables;
 * `headlessVar` is a template like `'HEADLESS:{value}'` for tools that thread a
 * headless flag into the command (e.g. Robot Framework).
 */
export interface ToolRunCapability {
  readonly vars?: readonly ToolRunVar[];
  readonly headlessVar?: string;
}

/**
 * Optional reports-capability block. `resultGlob` locates the tool's result
 * file (e.g. `summary.html`); `kind` is an optional descriptor such as `'html'`.
 * Absent ⇒ generic `**\/*.html` listing.
 */
export interface ToolReportsCapability {
  readonly resultGlob?: string;
  readonly kind?: string;
}

/**
 * Known tag-discovery strategies. Unknown / absent values resolve to `'none'`
 * so a new tool degrades to "no tag pre-scan" instead of throwing.
 */
export type ToolTagsStrategy = 'playwright-list' | 'robot-files' | 'none';

/**
 * Optional tags-capability block. `strategy` is an open string at the schema
 * level (any value parses); `resolveCapabilities()` maps unknown values to
 * `'none'`.
 */
export interface ToolTagsCapability {
  readonly strategy?: string;
}

/**
 * Capability blocks resolved with their safe defaults. Downstream Phase B
 * consumers read this shape via `resolveCapabilities(manifest)`
 * rather than touching the optional raw fields directly, so a missing block can
 * never surface as `undefined`.
 */
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

export interface ToolManifest {
  readonly $schema?: string;
  readonly schemaVersion: ManifestSchemaVersion;
  readonly id: ToolId;
  readonly alias: ToolAlias;
  readonly title: string;
  readonly description: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly runtime: ToolRuntime;
  readonly packageManager: ToolPackageManager;
  readonly taskfile: string;

  readonly projects: ToolProjectsConfig;
  readonly compose: ToolComposeConfig;
  readonly tsconfigGen: ToolTsconfigGenConfig | null;
  readonly docker: ToolDockerConfig;
  readonly runner: ToolRunnerConfig;
  readonly pipeline: ToolPipelineConfig;

  // Optional capability blocks; absent ⇒ safe defaults via
  // `resolveCapabilities()`. `schemaVersion` stays "1" — these are additive.
  readonly run?: ToolRunCapability;
  readonly reports?: ToolReportsCapability;
  readonly tags?: ToolTagsCapability;
  readonly versionFrom?: ToolVersionSourceConfig;
}

/**
 * Discrete failure code attached to a broken / invalid manifest. Each rejection
 * path maps to exactly one of these codes so consumers can branch on `code`
 * without parsing free-form messages.
 */
export type ManifestErrorCode =
  | 'SCHEMA_FAIL'
  | 'FOLDER_ID_MISMATCH'
  | 'DUPLICATE_ALIAS'
  | 'DUPLICATE_NAMESPACE'
  | 'TEMPLATE_MISSING'
  | 'COMPOSE_TEMPLATE_MISSING'
  | 'IO_ERROR';

export interface ManifestError {
  readonly code: ManifestErrorCode;
  readonly message: string;
  readonly path?: string;
}

/**
 * Outcome of loading + validating a single `tool.manifest.json`. A registry is
 * a list of these — broken manifests are kept (status `'invalid'`) so consumers
 * can surface them instead of silently dropping a tool.
 */
export interface ToolManifestRecord {
  readonly path: string;
  readonly status: 'ok' | 'invalid' | 'disabled';
  readonly manifest: ToolManifest | null;
  readonly errors: readonly ManifestError[];
}

// ── Tool Registry types (formerly registry.types.ts) ────────────────────────
// Shape of `config/tool-registry.json` — the workspace-local list of
// installable tool repositories. Repository pointers only; no manifest content
// is embedded.

export interface ToolRegistryEntry {
  /** Folder name to clone into (must match the manifest's `id`). */
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** Git URL — https, ssh, or git@host:path. */
  readonly gitUrl: string;
  /** Branch, tag, or commit SHA. */
  readonly ref: string;
  /** Path of the manifest within the cloned repo. Default: 'tool.manifest.json'. */
  readonly manifestPath?: string;
  /** Optional list of compatible workspace versions (semver range). */
  readonly compatibleWith?: string;
}

export interface ToolRegistry {
  readonly $schema?: string;
  readonly schemaVersion: '1';
  readonly tools: readonly ToolRegistryEntry[];
}
