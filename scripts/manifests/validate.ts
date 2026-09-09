// scripts/manifests/validate.ts
//
// Schema validation for `tool.manifest.json`. Two layers:
//   1. `validateManifest()` — single-manifest schema check (zod). Never throws;
//      always returns a structured result (never throws — property-tested).
//   2. `validateRegistry()` — cross-manifest invariants (alias / namespace
//      uniqueness, folder-vs-id match) applied after individual validation.
//
// The zod schema mirrors `scripts/manifests/schemas/tool.manifest.schema.json`; keep the
// two in sync when either changes.
import * as path from 'node:path';
import { z } from 'zod';
import type {
  ManifestError,
  ManifestErrorCode,
  ResolvedCapabilities,
  ToolManifest,
  ToolManifestRecord,
  ToolTagsStrategy,
} from './types.js';

const ToolIdSchema = z.string().regex(/^[a-z][a-z0-9-]+$/);
const ToolAliasSchema = z.string().regex(/^[a-z][a-z0-9]*$/);
const NamespaceSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);

const PassAsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), key: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }),
  z.object({ kind: z.literal('cli') }),
  z.object({ kind: z.literal('none') }),
]);

const WhenSchema = z.record(z.string(), z.unknown());

const RunnerStepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('selectDirs'),
    id: z.string(),
    title: z.string(),
    from: z.string(),
    exclude: z.string().optional(),
    when: WhenSchema.optional(),
    preAction: z.string().optional(),
    passAs: PassAsSchema,
    dockerOverride: z.string().optional(),
  }),
  z.object({
    kind: z.literal('select'),
    id: z.string(),
    title: z.string(),
    choices: z.array(z.object({ title: z.string(), value: z.string() })),
    when: WhenSchema.optional(),
    preAction: z.string().optional(),
    passAs: PassAsSchema,
    dockerOverride: z.string().optional(),
  }),
  z.object({
    kind: z.literal('text'),
    id: z.string(),
    title: z.string(),
    initial: z.string().optional(),
    when: WhenSchema.optional(),
    preAction: z.string().optional(),
    passAs: PassAsSchema,
    dockerOverride: z.string().optional(),
  }),
]);

/**
 * Optional capability blocks. All fields are optional and the
 * blocks themselves are optional on the manifest; `schemaVersion` stays "1"
 * because every addition is additive. `tags.strategy` is an open string here —
 * unknown values are tolerated at parse time and normalised to `'none'` by
 * `resolveCapabilities()`.
 */
const RunVarSchema = z.object({
  name: z.string(),
  when: z.enum(['sectionAxis', 'always']),
});

const RunCapabilitySchema = z.object({
  vars: z.array(RunVarSchema).optional(),
  headlessVar: z.string().optional(),
});

const ReportsCapabilitySchema = z.object({
  resultGlob: z.string().optional(),
  kind: z.string().optional(),
});

const TagsCapabilitySchema = z.object({
  strategy: z.string().optional(),
});

/**
 * Full `tool.manifest.json` schema. Refinements encode the two cross-field
 * invariants that cannot be expressed structurally:
 *   - `typeAxis === false` ⇒ `fixedType` must be a non-null string.
 *   - `runner.steps[].id` must be unique within the array.
 */
export const ToolManifestSchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal('1'),
  id: ToolIdSchema,
  alias: ToolAliasSchema,
  title: z.string().min(1),
  description: z.string(),
  version: z.string(),
  enabled: z.boolean(),
  runtime: z.enum(['node', 'python', 'binary']),
  packageManager: z.enum(['pnpm', 'uv', 'none']),
  taskfile: z.string(),
  projects: z
    .object({
      root: z.string().default('projects'),
      depth: z.union([z.literal(1), z.literal(2)]),
      typeAxis: z.boolean(),
      fixedType: z.string().nullable(),
      templates: z.record(z.string(), z.string()),
      specsSubdir: z.string().default('automations/specs'),
      sectionAxis: z.boolean(),
    })
    .refine((p) => p.typeAxis || p.fixedType !== null, {
      message: 'fixedType is required when typeAxis is false',
      path: ['fixedType'],
    }),
  compose: z.object({
    template: z.string(),
    anchor: z.string(),
    networks: z.array(NamespaceSchema),
  }),
  tsconfigGen: z
    .object({
      template: z.string(),
      output: z.string(),
      aliasPrefix: z.string(),
      aliasTarget: z.string(),
    })
    .nullable(),
  docker: z.object({
    baseImage: z.string(),
    extras: z.array(z.string()),
  }),
  runner: z.object({
    taskNamespace: NamespaceSchema,
    title: z.string(),
    executionTypes: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        commandTemplate: z.string(),
      }),
    ),
    environments: z.array(z.enum(['local', 'docker'])),
    steps: z
      .array(RunnerStepSchema)
      .refine((steps) => new Set(steps.map((s) => s.id)).size === steps.length, {
        message: 'runner.steps[].id must be unique',
      }),
    commandTemplate: z.string(),
  }),
  pipeline: z.object({
    id: z.string(),
    targetPaths: z.record(z.string(), z.string()),
    envToken: z.string(),
    runCommands: z.record(z.string(), z.string()),
    artifactPaths: z.array(z.string()),
  }),
  // Optional capability blocks — additive, schemaVersion stays "1".
  run: RunCapabilitySchema.optional(),
  reports: ReportsCapabilitySchema.optional(),
  tags: TagsCapabilitySchema.optional(),
  versionFrom: z.object({ file: z.string().min(1), dependency: z.string().min(1) }).optional(),
});

/** Successful single-manifest validation carries the fully-typed manifest. */
export type ValidateManifestResult =
  | { readonly ok: true; readonly manifest: ToolManifest }
  | { readonly ok: false; readonly errors: ManifestError[] };

function issuesToErrors(issues: readonly z.core.$ZodIssue[]): ManifestError[] {
  if (issues.length === 0) {
    return [{ code: 'SCHEMA_FAIL', message: 'manifest failed schema validation' }];
  }
  return issues.map((issue) => {
    const dotted = issue.path.map((p) => String(p)).join('.');
    return {
      code: 'SCHEMA_FAIL' as ManifestErrorCode,
      message: dotted.length > 0 ? `${dotted}: ${issue.message}` : issue.message,
      path: dotted.length > 0 ? dotted : undefined,
    } satisfies ManifestError;
  });
}

/**
 * Validate an arbitrary JSON value against the manifest schema.
 *
 * Guarantee (property-tested): NEVER throws. Returns either
 * `{ ok: true, manifest }` with a fully-typed manifest, or `{ ok: false, errors }`
 * with at least one `ManifestError` carrying a specific code. The outer
 * try/catch is a belt-and-braces guard so even an unexpected zod internal error
 * surfaces as a structured `SCHEMA_FAIL` rather than a thrown exception.
 */
export function validateManifest(input: unknown): ValidateManifestResult {
  try {
    const parsed = ToolManifestSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, errors: issuesToErrors(parsed.error.issues) };
    }
    // zod infers `id`/`alias` as plain `string`; the manifest contract brands
    // them as `ToolId`/`ToolAlias`. The values are structurally identical, so a
    // single cast through `unknown` re-attaches the nominal brands.
    return { ok: true, manifest: parsed.data as unknown as ToolManifest };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [{ code: 'SCHEMA_FAIL', message }] };
  }
}

/**
 * Default report glob used when a manifest declares no `reports.resultGlob`.
 * Generic enough to surface any HTML report a tool emits.
 */
export const DEFAULT_REPORT_GLOB = '**/*.html';

/** Known tag strategies; anything else resolves to `'none'`. */
const KNOWN_TAGS_STRATEGIES: ReadonlySet<ToolTagsStrategy> = new Set([
  'playwright-list',
  'robot-files',
  'none',
]);

/**
 * Resolve a manifest's optional capability blocks to fully-populated, safe
 * defaults ("degrade, don't break").
 *
 * Default-resolution contract — an ABSENT block yields:
 *   - `run`:     `{ vars: [], headlessVar: null }`     (no extra run vars)
 *   - `reports`: `{ resultGlob: '**\/*.html', kind: null }` (generic listing)
 *   - `tags`:    `{ strategy: 'none' }`                 (no tag pre-scan)
 *
 * An UNKNOWN `tags.strategy` (any value outside the known set) also resolves to
 * `'none'` rather than throwing. Downstream consumers
 * call this once and read the resolved shape, never the raw optional fields.
 */
export function resolveCapabilities(manifest: ToolManifest): ResolvedCapabilities {
  const rawStrategy = manifest.tags?.strategy;
  const strategy: ToolTagsStrategy =
    rawStrategy !== undefined && KNOWN_TAGS_STRATEGIES.has(rawStrategy as ToolTagsStrategy)
      ? (rawStrategy as ToolTagsStrategy)
      : 'none';

  return {
    run: {
      vars: manifest.run?.vars ?? [],
      headlessVar: manifest.run?.headlessVar ?? null,
    },
    reports: {
      resultGlob: manifest.reports?.resultGlob ?? DEFAULT_REPORT_GLOB,
      kind: manifest.reports?.kind ?? null,
    },
    tags: { strategy },
  };
}

/** Derive the containing folder name from a manifest path `.../tools/<id>/tool.manifest.json`. */
function folderNameOf(manifestPath: string): string {
  return path.basename(path.dirname(manifestPath));
}

function withError(record: ToolManifestRecord, error: ManifestError): ToolManifestRecord {
  return {
    ...record,
    status: 'invalid',
    errors: [...record.errors, error],
  };
}

/**
 * Apply cross-manifest invariants after individual schema validation
 * — the cross-manifest rules:
 *   - FOLDER_ID_MISMATCH — `manifest.id` must equal the containing folder name
 *     — applies to every record carrying a manifest.
 *   - DUPLICATE_ALIAS / DUPLICATE_NAMESPACE — no two ENABLED manifests may share
 *     an `alias` or `runner.taskNamespace`. ALL members of a colliding group are
 *     marked invalid so neither silently wins.
 *
 * Records already `status === 'invalid'` are passed through untouched (uniqueness
 * is only meaningful for otherwise-valid manifests). Returns a new array; inputs
 * are not mutated, preserving order-independence.
 */
export function validateRegistry(
  records: readonly ToolManifestRecord[],
): readonly ToolManifestRecord[] {
  // Pass 1: folder-vs-id match for every record that parsed successfully.
  let working: ToolManifestRecord[] = records.map((record) => {
    if (record.status !== 'ok' || record.manifest === null) return record;
    const folder = folderNameOf(record.path);
    if (record.manifest.id !== folder) {
      return withError(record, {
        code: 'FOLDER_ID_MISMATCH',
        message: `manifest id "${record.manifest.id}" does not match folder "${folder}"`,
        path: record.path,
      });
    }
    return record;
  });

  // Pass 2: alias + namespace uniqueness across still-valid ENABLED manifests.
  working = markDuplicates(
    working,
    (m) => m.alias,
    'DUPLICATE_ALIAS',
    (value) => `alias "${value}" is claimed by more than one enabled tool`,
  );
  working = markDuplicates(
    working,
    (m) => m.runner.taskNamespace,
    'DUPLICATE_NAMESPACE',
    (value) => `runner.taskNamespace "${value}" is claimed by more than one enabled tool`,
  );

  return working;
}

function markDuplicates(
  records: readonly ToolManifestRecord[],
  keyOf: (manifest: ToolManifest) => string,
  code: ManifestErrorCode,
  messageOf: (value: string) => string,
): ToolManifestRecord[] {
  const groups = new Map<string, number[]>();
  records.forEach((record, index) => {
    if (record.status !== 'ok' || record.manifest === null || !record.manifest.enabled) return;
    const key = keyOf(record.manifest);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [index]);
    else bucket.push(index);
  });

  const collisions = new Map<number, string>();
  for (const [key, indices] of groups) {
    if (indices.length > 1) {
      for (const index of indices) collisions.set(index, key);
    }
  }

  return records.map((record, index) => {
    const value = collisions.get(index);
    if (value === undefined) return record;
    return withError(record, { code, message: messageOf(value), path: record.path });
  });
}
