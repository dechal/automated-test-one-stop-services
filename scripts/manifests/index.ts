// scripts/manifests/index.ts
//
// Public entry point for the manifest layer. Every consumer (sync-projects,
// create-project, runner, pipeline projection, hub server) imports from here.
//
// Responsibilities:
//   - `createManifestRegistry()` — a cached, re-scannable view of every
//     `tool.manifest.json` in the workspace.
//   - `setToolEnabled()` — flip `manifest.enabled` on disk (commit scope) and
//     return the refreshed record.
//   - `loadToolRegistry()` — read `config/tool-registry.json`.
//   - Re-export the types + validation helpers consumers need so they only ever
//     depend on `./manifests/index.js`.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { discoverManifestPaths } from './discover.js';
import { createEnabledResolver } from './overrides.js';
import type { ManifestError, ToolManifest, ToolManifestRecord, ToolRegistry } from './types.js';
import { validateManifest, validateRegistry } from './validate.js';

export {
  discoverManifestPaths,
  discoverToolIds,
  isToolPresent,
  MANIFEST_FILENAME,
} from './discover.js';
export { isTemplate, listDirs, listProjectDirs } from './fs-helpers.js';
export {
  loadPipelineStatic,
  type PipelineProjection,
  type PipelineStaticParts,
  projectPipeline,
} from './pipeline-projection.js';
export {
  buildHeadlessToken,
  buildRunCommandFromInput,
  buildRunVarTokens,
  buildTaskCommand,
  type RunCommandInput,
  type RunnerAnswers,
  type RunnerContext,
  resolveHeadlessStepValue,
} from './runner-command.js';
// ── Re-exports ──────────────────────────────────────────────────────────────
// Consumers depend on `./manifests/index.js` alone; surface the public shapes
// and helpers here so individual module paths stay private.
export type {
  ManifestError,
  ManifestErrorCode,
  ManifestSchemaVersion,
  ResolvedCapabilities,
  ResolvedReportsCapability,
  ResolvedRunCapability,
  ResolvedTagsCapability,
  ToolAlias,
  ToolCleanConfig,
  ToolComposeConfig,
  ToolDockerConfig,
  ToolEnv,
  ToolId,
  ToolManifest,
  ToolManifestRecord,
  ToolPackageManager,
  ToolPipelineConfig,
  ToolProjectsConfig,
  ToolRegistry,
  ToolRegistryEntry,
  ToolReportsCapability,
  ToolRequirement,
  ToolRequirementInstall,
  ToolRunCapability,
  ToolRunnerConfig,
  ToolRunnerPassAs,
  ToolRunnerStep,
  ToolRunnerWhen,
  ToolRuntime,
  ToolRunVar,
  ToolRunVarWhen,
  ToolTagsCapability,
  ToolTagsStrategy,
  ToolTsconfigGenConfig,
} from './types.js';
export {
  DEFAULT_REPORT_GLOB,
  resolveCapabilities,
  ToolManifestSchema,
  type ValidateManifestResult,
  validateManifest,
  validateRegistry,
} from './validate.js';

/** Path of the workspace tool registry, relative to the workspace root. */
const TOOL_REGISTRY_PATH = path.join('config', 'tool-registry.json');

// ── Registry validation (zod) ───────────────────────────────────────────────
// Mirrors `scripts/manifests/schemas/tool-registry.schema.json` (JSON Schema Draft-07).
// Keep the two in sync when either changes.

const ToolRegistryEntrySchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]+$/),
  title: z.string().min(1),
  description: z.string(),
  gitUrl: z.string().min(1),
  ref: z.string().min(1),
  manifestPath: z.string().optional(),
  compatibleWith: z.string().optional(),
});

const ToolRegistrySchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal('1'),
  tools: z.array(ToolRegistryEntrySchema),
});

type ValidateToolRegistryResult =
  | { readonly ok: true; readonly registry: ToolRegistry }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Validate an arbitrary JSON value against the `ToolRegistry` schema.
 * Never throws — returns a structured result (fail-closed pattern).
 */
function validateToolRegistry(input: unknown): ValidateToolRegistryResult {
  try {
    const parsed = ToolRegistrySchema.safeParse(input);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((issue) => {
        const dotted = issue.path.map((p) => String(p)).join('.');
        return dotted.length > 0 ? `${dotted}: ${issue.message}` : issue.message;
      });
      return { ok: false, errors: errors.length > 0 ? errors : ['unknown schema error'] };
    }
    return { ok: true, registry: parsed.data as unknown as ToolRegistry };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [message] };
  }
}

/**
 * A cached, re-scannable registry of tool manifests. Discovery + validation run
 * on `refresh()`; query methods read the in-memory snapshot so repeated calls
 * are IO-free. After mutating disk (hub install / disable, `setToolEnabled`),
 * call `refresh()` to rebuild the snapshot.
 */
export interface ManifestRegistry {
  /** Every discovered manifest record: ok, disabled, and invalid alike. */
  all(): readonly ToolManifestRecord[];
  /** Manifests that validated AND resolve to enabled. */
  enabled(): readonly ToolManifest[];
  byId(id: string): ToolManifest | undefined;
  byAlias(alias: string): ToolManifest | undefined;
  byNamespace(namespace: string): ToolManifest | undefined;
  /** Re-scan disk and re-validate. Idempotent — repeated calls converge. */
  refresh(): Promise<void>;
}

/**
 * Resolves whether a (schema-valid) manifest should be treated as enabled.
 *
 * RESOLUTION POINT — this is the single seam where local overrides slot in.
 * The resolver is produced by `createEnabledResolver()` (`overrides.ts`), which
 * reads `config/.tool-overrides.json` and applies the documented precedence
 * (local override > manifest.enabled > implicit true).
 */
export type EnabledResolver = (manifest: ToolManifest) => boolean;

/** Read + parse a single manifest file into a `ToolManifestRecord`. */
function loadRecord(manifestPath: string): ToolManifestRecord {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return invalidRecord(manifestPath, { code: 'IO_ERROR', message, path: manifestPath });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return invalidRecord(manifestPath, {
      code: 'SCHEMA_FAIL',
      message: `invalid JSON: ${message}`,
      path: manifestPath,
    });
  }

  const result = validateManifest(parsed);
  if (!result.ok) {
    return { path: manifestPath, status: 'invalid', manifest: null, errors: result.errors };
  }
  const manifest = withDerivedBaseImage(path.dirname(manifestPath), result.manifest);
  return { path: manifestPath, status: 'ok', manifest, errors: [] };
}

const DOCKERFILE = 'Dockerfile';
const DOCKERFILE_FROM = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/gim;
const COMPOSE_IMAGE = /^\s*image:\s*["']?([^\s"'#]+)/m;

function readTextOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export function baseImageFromDockerfile(text: string): string {
  const stages = new Set<string>();
  let image = '';
  for (const match of text.matchAll(DOCKERFILE_FROM)) {
    const ref = match[1] ?? '';
    if (!stages.has(ref.toLowerCase())) image = ref;
    if (match[2] !== undefined) stages.add(match[2].toLowerCase());
  }
  return image;
}

export function baseImageFromCompose(text: string): string {
  return COMPOSE_IMAGE.exec(text)?.[1] ?? '';
}

function withDerivedBaseImage(toolDir: string, manifest: ToolManifest): ToolManifest {
  const derived =
    baseImageFromDockerfile(readTextOrEmpty(path.join(toolDir, DOCKERFILE))) ||
    baseImageFromCompose(readTextOrEmpty(path.join(toolDir, manifest.compose.template)));
  if (derived === '' || derived === manifest.docker.baseImage) return manifest;
  return { ...manifest, docker: { ...manifest.docker, baseImage: derived } };
}

function invalidRecord(manifestPath: string, error: ManifestError): ToolManifestRecord {
  return { path: manifestPath, status: 'invalid', manifest: null, errors: [error] };
}

/**
 * Apply enabled-resolution to the post-`validateRegistry` records. A valid
 * manifest that resolves to disabled is re-tagged `status: 'disabled'` so
 * `enabled()` can filter on status alone, while `all()` still surfaces it.
 * Invalid records pass through untouched.
 */
function applyResolution(
  records: readonly ToolManifestRecord[],
  resolveEnabled: EnabledResolver,
): ToolManifestRecord[] {
  return records.map((record) => {
    if (record.status === 'invalid' || record.manifest === null) return record;
    const isEnabled = resolveEnabled(record.manifest);
    const status: ToolManifestRecord['status'] = isEnabled ? 'ok' : 'disabled';
    return { ...record, status };
  });
}

/**
 * Construct a registry rooted at `workspaceRoot`. The snapshot starts empty;
 * call `refresh()` before querying. Cache lives until the next `refresh()`.
 */
export function createManifestRegistry(workspaceRoot: string): ManifestRegistry {
  let records: readonly ToolManifestRecord[] = [];

  type ValidRecord = ToolManifestRecord & { manifest: ToolManifest };
  const hasManifest = (r: ToolManifestRecord): r is ValidRecord =>
    r.manifest !== null && r.status !== 'invalid';

  /** Manifests usable for lookups: schema-valid (ok or merely disabled). */
  const lookupManifests = (): ToolManifest[] => records.filter(hasManifest).map((r) => r.manifest);

  return {
    all: () => records,
    enabled: () =>
      records
        .filter((r): r is ValidRecord => r.status === 'ok' && r.manifest !== null)
        .map((r) => r.manifest),
    byId: (id) => lookupManifests().find((m) => m.id === id),
    byAlias: (alias) => lookupManifests().find((m) => m.alias === alias),
    byNamespace: (namespace) => lookupManifests().find((m) => m.runner.taskNamespace === namespace),
    refresh: async () => {
      const resolveEnabled = createEnabledResolver(workspaceRoot);
      const paths = discoverManifestPaths(workspaceRoot);
      const loaded = paths.map(loadRecord);
      const validated = validateRegistry(loaded);
      records = applyResolution(validated, resolveEnabled);
    },
  };
}

/**
 * Set `manifest.enabled` for tool `id` on disk (commit scope) and return the
 * refreshed record. Preserves the manifest's key order by mutating the parsed
 * object in place rather than re-serialising from a typed shape.
 *
 * Local-override (`scope: 'local'`) writes are handled by the overrides module
 * and the hub service; this function always writes the committed manifest file.
 */
export async function setToolEnabled(
  registry: ManifestRegistry,
  id: string,
  enabled: boolean,
): Promise<ToolManifestRecord> {
  const record = registry.all().find((r) => r.manifest?.id === id);
  if (record === undefined || record.manifest === null) {
    throw new Error(`Unknown tool id: ${id}`);
  }

  const raw = fs.readFileSync(record.path, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  parsed.enabled = enabled;
  fs.writeFileSync(record.path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');

  await registry.refresh();

  const updated = registry.all().find((r) => r.manifest?.id === id);
  if (updated === undefined) {
    throw new Error(`Tool ${id} disappeared after refresh`);
  }
  return updated;
}

/** Empty registry constant — returned when the file is absent or malformed. */
const EMPTY_REGISTRY: ToolRegistry = { schemaVersion: '1', tools: [] };

/**
 * Read `config/tool-registry.json`. Returns an empty registry when
 * the file is absent or malformed (fail-closed) so callers can treat both cases
 * the same as "registry with no tools". Validates the loaded JSON against the
 * `ToolRegistry` schema.
 */
export async function loadToolRegistry(workspaceRoot: string): Promise<ToolRegistry> {
  const registryPath = path.join(workspaceRoot, TOOL_REGISTRY_PATH);
  if (!fs.existsSync(registryPath)) {
    return EMPTY_REGISTRY;
  }

  let raw: string;
  try {
    raw = await fs.promises.readFile(registryPath, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`⚠ Could not read tool registry: ${message}`);
    return EMPTY_REGISTRY;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`⚠ Tool registry is not valid JSON: ${message}`);
    return EMPTY_REGISTRY;
  }

  const result = validateToolRegistry(parsed);
  if (!result.ok) {
    for (const error of result.errors) {
      console.warn(`⚠ Tool registry validation failed: ${error}`);
    }
    return EMPTY_REGISTRY;
  }

  return result.registry;
}
