// scripts/manifests/__tests__/properties.spec.ts
//
// Property-based tests for the 10 correctness properties of the manifest module.
// Each test uses fast-check arbitraries (see `arbitraries.ts`) and states the
// invariant it holds in its own title.
//
// Uses fc.assert(fc.asyncProperty(...)) / fc.assert(fc.property(...)) with vitest
// (no @fast-check/vitest package in this workspace — plain vitest + fc.assert).
//
// Run via: npx vitest run (inside scripts/manifests/)

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverManifestPaths } from '../discover.js';
import { isTemplate, listProjectDirs } from '../fs-helpers.js';
import { createManifestRegistry, validateManifest, validateRegistry } from '../index.js';
import { projectPipeline } from '../pipeline-projection.js';
import { buildTaskCommand, type RunnerAnswers } from '../runner-command.js';
import type { ManifestError, ToolManifest, ToolManifestRecord } from '../types.js';
import {
  arbToolManifest,
  arbTwoManifestsSameAlias,
  arbTwoManifestsSameNamespace,
} from './arbitraries.js';

// ── Workspace helpers ─────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function tmpWs(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'props-test-'));
  tmpDirs.push(d);
  return d;
}

function writeManifest(ws: string, manifest: ToolManifest): string {
  const toolDir = path.join(ws, 'tools', manifest.id);
  fs.mkdirSync(toolDir, { recursive: true });
  const manifestPath = path.join(toolDir, 'tool.manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return manifestPath;
}

function emptyStaticParts() {
  return { routing: {}, id_conventions: {}, test_case_vocab: {} };
}

async function buildRegistry(ws: string) {
  const registry = createManifestRegistry(ws);
  await registry.refresh();
  return registry;
}

function okRecord(manifest: ToolManifest): ToolManifestRecord {
  return {
    path: `/tmp/tools/${manifest.id}/tool.manifest.json`,
    status: 'ok',
    manifest,
    errors: [],
  };
}

function stripTimestamp(p: ReturnType<typeof projectPipeline>): string {
  const clone = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
  (clone._generated as Record<string, unknown>).at = 'FIXED';
  return JSON.stringify(clone);
}

// =============================================================================
// Drop-in completeness
// new tool appears in registry + pipeline after sync.
// =============================================================================
describe('drop-in completeness', () => {
  it('enabled tool appears in pipeline target_paths, run_commands and docker_base_images after sync', async () => {
    await fc.assert(
      fc.asyncProperty(arbToolManifest(), async (manifest) => {
        const m: ToolManifest = { ...manifest, enabled: true };
        const ws = tmpWs();
        writeManifest(ws, m);

        const registry = await buildRegistry(ws);
        const projection = projectPipeline(registry, emptyStaticParts());

        const tp = projection.target_paths as Record<string, string>;
        const hasTarget = Object.keys(tp).some(
          (k) => k === m.pipeline.id || k.startsWith(`${m.pipeline.id}_`),
        );
        expect(hasTarget).toBe(true);

        const rc = projection.run_commands as Record<string, unknown>;
        expect(rc[m.pipeline.id]).toBeDefined();

        const db = projection.docker_base_images as Record<string, string>;
        expect(db[m.pipeline.id]).toBeDefined();
      }),
      { numRuns: 25 },
    );
  });
});

// =============================================================================
// Removal cleanliness
// removed tool disappears from all sections.
// =============================================================================
describe('removal cleanliness', () => {
  it('after removing a tool folder its pipeline sections disappear; bystander tool is unaffected', async () => {
    await fc.assert(
      fc.asyncProperty(arbToolManifest(), async (manifest) => {
        const m: ToolManifest = { ...manifest, enabled: true };
        const ws = tmpWs();

        // Bystander with fixed distinct id/alias/namespace
        const bystander: ToolManifest = {
          ...m,
          id: 'bystander' as ToolManifest['id'],
          alias: 'bys' as ToolManifest['alias'],
          runner: { ...m.runner, taskNamespace: 'bystander' },
          pipeline: {
            ...m.pipeline,
            id: 'bystander',
            targetPaths: { default: 'tools/bystander/projects/{p}/spec.ts' },
            runCommands: { local: 'task bystander:run-local' },
          },
        };

        writeManifest(ws, m);
        writeManifest(ws, bystander);

        // Remove the generated tool
        fs.rmSync(path.join(ws, 'tools', m.id), { recursive: true, force: true });

        const registry = await buildRegistry(ws);
        const projection = projectPipeline(registry, emptyStaticParts());
        const tp = projection.target_paths as Record<string, string>;
        const rc = projection.run_commands as Record<string, unknown>;

        // Removed tool must not appear
        const removedInTarget = Object.keys(tp).some(
          (k) => k === m.pipeline.id || k.startsWith(`${m.pipeline.id}_`),
        );
        expect(removedInTarget).toBe(false);
        expect(rc[m.pipeline.id]).toBeUndefined();

        // Bystander must still appear (when distinct from removed tool)
        if (m.id !== 'bystander') {
          expect(rc['bystander']).toBeDefined();
        }
      }),
      { numRuns: 25 },
    );
  });
});

// =============================================================================
// Discovery idempotence
// same registry regardless of filesystem iteration order.
// =============================================================================
describe('discovery idempotence', () => {
  it('discoverManifestPaths returns an identical sorted list on repeated scans', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 0, maxLength: 5 }),
        (indices) => {
          const ws = tmpWs();
          for (const i of new Set(indices)) {
            const toolDir = path.join(ws, 'tools', `tool${i}`);
            fs.mkdirSync(toolDir, { recursive: true });
            fs.writeFileSync(
              path.join(toolDir, 'tool.manifest.json'),
              JSON.stringify({ id: `tool${i}` }),
              'utf8',
            );
          }

          const first = discoverManifestPaths(ws);
          const second = discoverManifestPaths(ws);
          expect(first).toEqual(second);
          // Verify the list is sorted
          expect(first).toEqual([...first].sort());
        },
      ),
      { numRuns: 50 },
    );
  });
});

// =============================================================================
// Determinism (multiple refreshes yield identical output)
// same tools → identical pipeline.json across refreshes.
// =============================================================================
describe('determinism across multiple refreshes', () => {
  it('pipeline projection is byte-identical across multiple registry refreshes (modulo timestamp)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 1, maxLength: 4 }),
        async (indices) => {
          const ws = tmpWs();
          const uniqueIndices = [...new Set(indices)];
          for (const i of uniqueIndices) {
            const m: ToolManifest = {
              schemaVersion: '1',
              id: `tooldet${i}` as ToolManifest['id'],
              alias: `td${i}` as ToolManifest['alias'],
              title: `Tool ${i}`,
              description: '',
              version: '1.0.0',
              enabled: true,
              runtime: 'node',
              packageManager: 'pnpm',
              taskfile: 'Taskfile.yml',
              projects: {
                root: 'projects',
                depth: 2,
                typeAxis: true,
                fixedType: null,
                templates: { default: `projects/web/t${i}-template-example` },
                specsSubdir: 'automations/specs',
                sectionAxis: false,
              },
              compose: {
                template: 'docker-compose.template.yml',
                anchor: `t${i}-tmpl`,
                networks: [],
              },
              tsconfigGen: null,
              docker: { baseImage: `docker.io/t${i}:latest`, extras: ['task'] },
              runner: {
                taskNamespace: `td${i}`,
                title: `Tool ${i}`,
                executionTypes: [
                  { id: 'run', title: 'Run', commandTemplate: '{ns}:run-{environment}' },
                ],
                environments: ['local', 'docker'],
                commandTemplate: 'task {ns}:run-{environment}',
                steps: [],
              },
              pipeline: {
                id: `tooldet${i}`,
                targetPaths: { default: `tools/tooldet${i}/projects/{p}/spec.ts` },
                envToken: 'process.env.{KEY}',
                runCommands: { local: `task td${i}:run-local` },
                artifactPaths: [`outputs/tooldet${i}/`],
              },
            };
            writeManifest(ws, m);
          }

          const registryA = await buildRegistry(ws);
          const projA = projectPipeline(registryA, emptyStaticParts());

          const registryB = await buildRegistry(ws);
          const projB = projectPipeline(registryB, emptyStaticParts());

          expect(stripTimestamp(projA)).toBe(stripTimestamp(projB));
        },
      ),
      { numRuns: 25 },
    );
  });
});

// =============================================================================
// Isolation (disabled-tool invisibility)
// disabled tools absent from enabled() and all generated outputs.
// =============================================================================
describe('disabled-tool invisibility', () => {
  it('disabled tool is absent from enabled() and all pipeline sections', async () => {
    await fc.assert(
      fc.asyncProperty(arbToolManifest(), async (manifest) => {
        const disabled: ToolManifest = { ...manifest, enabled: false };
        const ws = tmpWs();
        writeManifest(ws, disabled);

        const registry = await buildRegistry(ws);

        // Not in enabled()
        const enabledIds = registry.enabled().map((m) => m.id);
        expect(enabledIds).not.toContain(disabled.id);

        const projection = projectPipeline(registry, emptyStaticParts());
        const tp = projection.target_paths as Record<string, string>;
        const rc = projection.run_commands as Record<string, unknown>;
        const db = projection.docker_base_images as Record<string, string>;
        const ap = projection.artifact_paths as Record<string, unknown>;
        const ei = projection.env_injection as Record<string, unknown>;
        const pid = disabled.pipeline.id;

        expect(Object.keys(tp).some((k) => k === pid || k.startsWith(`${pid}_`))).toBe(false);
        expect(rc[pid]).toBeUndefined();
        expect(db[pid]).toBeUndefined();
        expect(ap[pid]).toBeUndefined();
        expect(ei[pid]).toBeUndefined();
      }),
      { numRuns: 25 },
    );
  });
});

// =============================================================================
// Validation soundness (never throws)
// validateManifest never throws on fc.anything().
// =============================================================================
describe('validator never throws on arbitrary input', () => {
  it('validateManifest never throws and always returns a structured result', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        let result: ReturnType<typeof validateManifest> | undefined;
        expect(() => {
          result = validateManifest(input);
        }).not.toThrow();

        const r = result!;
        if (r.ok) {
          expect(typeof r.manifest.id).toBe('string');
          expect(r.manifest.schemaVersion).toBe('1');
        } else {
          expect(r.errors.length).toBeGreaterThan(0);
          for (const err of r.errors) {
            expect(typeof err.code).toBe('string');
            expect(err.code.length).toBeGreaterThan(0);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// Command identity (buildTaskCommand same inputs = same output)
// buildTaskCommand is pure / deterministic.
// =============================================================================
describe('buildTaskCommand identity', () => {
  it('buildTaskCommand is pure: same manifest + answers always yields the same command', () => {
    fc.assert(
      fc.property(arbToolManifest(), (manifest) => {
        if (manifest.runner.executionTypes.length === 0) return;
        const executionType = manifest.runner.executionTypes[0].id;
        const answers: RunnerAnswers = { executionType, environment: 'local' };

        expect(buildTaskCommand(manifest, answers)).toBe(buildTaskCommand(manifest, answers));
      }),
      { numRuns: 100 },
    );
  });

  it('command always contains the tool taskNamespace', () => {
    fc.assert(
      fc.property(arbToolManifest(), (manifest) => {
        if (manifest.runner.executionTypes.length === 0) return;
        const executionType = manifest.runner.executionTypes[0].id;
        const answers: RunnerAnswers = { executionType, environment: 'local' };

        expect(buildTaskCommand(manifest, answers)).toContain(manifest.runner.taskNamespace);
      }),
      { numRuns: 100 },
    );
  });

  it('task-arg step with non-empty answer produces KEY=value in command', () => {
    fc.assert(
      fc.property(arbToolManifest(), (manifest) => {
        if (manifest.runner.executionTypes.length === 0) return;
        const taskStep = manifest.runner.steps.find((s) => s.passAs.kind === 'task');
        if (taskStep === undefined) return;

        const executionType = manifest.runner.executionTypes[0].id;
        const answers: RunnerAnswers = {
          executionType,
          environment: 'local',
          [taskStep.id]: 'myval',
        };

        const cmd = buildTaskCommand(manifest, answers);
        const key = (taskStep.passAs as { kind: 'task'; key: string }).key;
        expect(cmd).toContain(`${key}=myval`);
      }),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Disabled omission round-trip (enable/disable inverse)
// disable→enable restores the original on-disk state.
// =============================================================================
describe('enable/disable inverse', () => {
  it('disabling then re-enabling restores the tool to the enabled() list', async () => {
    await fc.assert(
      fc.asyncProperty(arbToolManifest(), async (manifest) => {
        const m: ToolManifest = { ...manifest, enabled: true };
        const ws = tmpWs();
        writeManifest(ws, m);

        const registry = await buildRegistry(ws);
        expect(registry.enabled().map((e) => e.id)).toContain(m.id);

        // Disable
        const manifestPath = path.join(ws, 'tools', m.id, 'tool.manifest.json');
        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        raw.enabled = false;
        fs.writeFileSync(manifestPath, JSON.stringify(raw, null, 2), 'utf8');
        await registry.refresh();
        expect(registry.enabled().map((e) => e.id)).not.toContain(m.id);

        // Re-enable
        raw.enabled = true;
        fs.writeFileSync(manifestPath, JSON.stringify(raw, null, 2), 'utf8');
        await registry.refresh();
        expect(registry.enabled().map((e) => e.id)).toContain(m.id);
      }),
      { numRuns: 25 },
    );
  });

  it('on-disk manifest.enabled is true after disable→enable round-trip', () => {
    fc.assert(
      fc.property(arbToolManifest(), (manifest) => {
        const m: ToolManifest = { ...manifest, enabled: true };
        const ws = tmpWs();
        const manifestPath = writeManifest(ws, m);

        // Disable
        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        raw.enabled = false;
        fs.writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

        // Re-enable
        raw.enabled = true;
        fs.writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

        const restored = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<
          string,
          unknown
        >;
        expect(restored.enabled).toBe(true);
        expect(restored.id).toBe(m.id);
      }),
      { numRuns: 50 },
    );
  });
});

// =============================================================================
// Template exclusion (*-template-example projects never in compose services)
// *-template-example projects never appear in compose services.
// =============================================================================
describe('*-template-example folders are excluded from project lists', () => {
  it('isTemplate returns true for any name containing -template-example', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), (prefix) => {
        expect(isTemplate(`${prefix}-template-example`)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('isTemplate returns false for names that do not contain -template-example', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.includes('-template-example')),
        (name) => {
          expect(isTemplate(name)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('listProjectDirs never returns -template-example names regardless of project layout', () => {
    fc.assert(
      fc.property(arbToolManifest(), (manifest) => {
        const ws = tmpWs();
        const toolDir = path.join(ws, 'tools', manifest.id);

        if (manifest.projects.depth === 1) {
          const fixed = manifest.projects.fixedType ?? 'projects';
          const dir = path.join(toolDir, manifest.projects.root, fixed);
          fs.mkdirSync(path.join(dir, 'real-project'), { recursive: true });
          fs.mkdirSync(path.join(dir, `${manifest.id}-template-example`), { recursive: true });
        } else {
          const dir = path.join(toolDir, manifest.projects.root, 'web');
          fs.mkdirSync(path.join(dir, 'real-project'), { recursive: true });
          fs.mkdirSync(path.join(dir, 'web-template-example'), { recursive: true });
        }

        const projects = listProjectDirs(toolDir, manifest.projects);
        expect(projects.some((p) => p.includes('-template-example'))).toBe(false);
      }),
      { numRuns: 50 },
    );
  });
});

// =============================================================================
// Namespace uniqueness invariant + validation completeness
// duplicate namespace/alias → both tools get broken status.
// =============================================================================
describe('namespace uniqueness invariant', () => {
  it('two enabled tools sharing taskNamespace are both marked broken with DUPLICATE_NAMESPACE', () => {
    fc.assert(
      fc.property(arbTwoManifestsSameNamespace(), ([mA, mB]) => {
        const result = validateRegistry([okRecord(mA), okRecord(mB)]);

        for (const r of result) {
          expect(r.status).toBe('invalid');
          expect(r.errors.map((e) => e.code)).toContain('DUPLICATE_NAMESPACE');
        }
      }),
      { numRuns: 100 },
    );
  });

  it('two enabled tools sharing alias are both marked broken with DUPLICATE_ALIAS', () => {
    fc.assert(
      fc.property(arbTwoManifestsSameAlias(), ([mA, mB]) => {
        const result = validateRegistry([okRecord(mA), okRecord(mB)]);

        for (const r of result) {
          expect(r.status).toBe('invalid');
          expect(r.errors.map((e) => e.code)).toContain('DUPLICATE_ALIAS');
        }
      }),
      { numRuns: 100 },
    );
  });

  it('a single enabled tool never triggers a uniqueness violation', () => {
    fc.assert(
      fc.property(arbToolManifest(), (manifest) => {
        const result = validateRegistry([okRecord({ ...manifest, enabled: true })]);
        const codes = result.flatMap((r) => r.errors.map((e: ManifestError) => e.code));
        expect(codes).not.toContain('DUPLICATE_NAMESPACE');
        expect(codes).not.toContain('DUPLICATE_ALIAS');
      }),
      { numRuns: 100 },
    );
  });

  it('every ManifestError produced by validateRegistry has a non-empty code string (validation completeness)', () => {
    // Validation completeness:
    // every ManifestError has a code.
    fc.assert(
      fc.property(arbToolManifest(), (manifest) => {
        // Force a FOLDER_ID_MISMATCH by using a path whose folder name != manifest.id
        const record: ToolManifestRecord = {
          path: `/tmp/tools/wrong-folder-name/tool.manifest.json`,
          status: 'ok',
          manifest: { ...manifest, enabled: true },
          errors: [],
        };
        const result = validateRegistry([record]);
        for (const r of result) {
          for (const err of r.errors as ManifestError[]) {
            expect(typeof err.code).toBe('string');
            expect(err.code.length).toBeGreaterThan(0);
            expect(typeof err.message).toBe('string');
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
