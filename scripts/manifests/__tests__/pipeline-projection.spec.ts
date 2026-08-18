// scripts/manifests/__tests__/pipeline-projection.spec.ts
//
// Unit tests for `scripts/manifests/pipeline-projection.ts`.
// Verifies the composed-key rule, the `{KEY}` env-token substitution, the
// docker-base-image format, disabled-tool omission, and the static-parts
// spread. Builds an isolated temp workspace seeded with the three real
// committed manifests so the projection is exercised against production data.
//
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createManifestRegistry } from '../index.js';
import {
  loadPipelineStatic,
  type PipelineProjection,
  projectPipeline,
} from '../pipeline-projection.js';
import { makeTmpDir, mkDir, realToolsPresent, rmTmpDir } from './_helpers.js';

/** Absolute path to the real workspace root (three levels up from this file). */
const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const REAL_TOOLS_DIR = path.join(WORKSPACE_ROOT, 'tools');
const REAL_STATIC = path.join(WORKSPACE_ROOT, 'config', 'pipeline.static.json');

const TOOL_IDS = ['playwright', 'robot-framework', 'k6'] as const;

/** Seed a temp workspace with copies of the three committed manifests. */
function seedWorkspace(): string {
  const ws = makeTmpDir('pipeline-proj-');
  for (const id of TOOL_IDS) {
    const dir = mkDir(ws, 'tools', id);
    fs.copyFileSync(
      path.join(REAL_TOOLS_DIR, id, 'tool.manifest.json'),
      path.join(dir, 'tool.manifest.json'),
    );
  }
  const settings = mkDir(ws, 'config');
  fs.copyFileSync(REAL_STATIC, path.join(settings, 'pipeline.static.json'));
  return ws;
}

async function buildProjection(ws: string): Promise<PipelineProjection> {
  const registry = createManifestRegistry(ws);
  await registry.refresh();
  return projectPipeline(registry, loadPipelineStatic(ws));
}

// These specs project the REAL committed manifests; skip where the built-in
// tool repos are not provisioned (fresh clone / CI) — see realToolsPresent.
describe.skipIf(!realToolsPresent(WORKSPACE_ROOT, TOOL_IDS))('projectPipeline', () => {
  let ws: string;

  beforeEach(() => {
    ws = seedWorkspace();
  });

  afterEach(() => {
    rmTmpDir(ws);
  });

  it('emits a _generated block sourced from tool.manifest.json with an ISO timestamp', async () => {
    const p = await buildProjection(ws);
    expect(p._generated.from).toBe('tool.manifest.json');
    expect(() => new Date(p._generated.at).toISOString()).not.toThrow();
    expect(new Date(p._generated.at).toISOString()).toBe(p._generated.at);
  });

  it('spreads the static routing + id_conventions sections', async () => {
    const p = await buildProjection(ws);
    const routing = p.routing as Record<string, unknown>;
    const idConv = p.id_conventions as Record<string, unknown>;
    expect(routing.stages).toBeDefined();
    expect(idConv.BR).toBe('Business Rule (BR-001)');
  });

  it('uses bare <id> for the default target_paths key', async () => {
    const p = await buildProjection(ws);
    // robot + k6 both use the "default" pipeline key.
    expect(p.target_paths.robot).toBe(
      'tools/robot-framework/projects/{type}/{project}/automations/specs/{domain}/{name}.robot',
    );
    expect(p.target_paths.k6).toBe(
      'tools/k6/projects/performance/{project}/automations/specs/{section}/e2e.spec.ts',
    );
  });

  it('uses composed <id>_<key> for non-default target_paths keys', async () => {
    const p = await buildProjection(ws);
    expect(p.target_paths.playwright_web).toBe(
      'tools/playwright/projects/web/{project}/automations/specs/{domain}/{kind}.spec.ts',
    );
    expect(p.target_paths.playwright_api).toBe(
      'tools/playwright/projects/api/{project}/automations/specs/{domain}/{kind}.spec.ts',
    );
    // No bare "playwright" key when every key is non-default.
    expect(p.target_paths.playwright).toBeUndefined();
  });

  it('substitutes {KEY} -> ENV_X so env_injection matches the historical tokens', async () => {
    const p = await buildProjection(ws);
    const env = p.env_injection as Record<string, string>;
    expect(env.playwright).toBe('process.env.ENV_X');
    expect(env.robot).toBe('%{ENV_X}');
    expect(env.k6).toBe('__ENV.ENV_X');
  });

  it('formats docker_base_images as "<baseImage> (+ <extras…>)"', async () => {
    const p = await buildProjection(ws);
    expect(p.docker_base_images.k6).toBe('grafana/k6:latest (+ task, pnpm, dotenvx, tsx)');
    expect(p.docker_base_images.robot).toBe(
      'python:3.14-slim (+ task, uv, rfbrowser-init-chromium)',
    );
    expect(p.docker_base_images.playwright).toBe(
      'mcr.microsoft.com/playwright:v{playwrightVersion}-noble (+ task, pnpm, dotenvx, tsx)',
    );
  });

  it('carries run_commands and artifact_paths per enabled tool', async () => {
    const p = await buildProjection(ws);
    expect(p.run_commands.playwright.local).toContain('task pw:run-local');
    expect(p.run_commands.k6.docker).toContain('task k6:run-docker');
    // Must mirror what the k6 Taskfile actually writes: `.temp/` is promoted to
    // `<status>/<date>/<time>/round_N/`. This assertion existed with the retired
    // `{year}/{user}/{month}/{day}/{time}` shape, which kept the stale value alive
    // in the generated pipeline.json that delivery globs for CI artifacts.
    expect(p.artifact_paths.k6).toEqual([
      'outputs/k6/{project}/{section}/{status}/{date}/{time}/round_{round}/',
    ]);
  });

  it('omits a disabled tool from every section', async () => {
    // Disable k6 by flipping enabled on the seeded copy.
    const k6Path = path.join(ws, 'tools', 'k6', 'tool.manifest.json');
    const k6 = JSON.parse(fs.readFileSync(k6Path, 'utf8')) as Record<string, unknown>;
    k6.enabled = false;
    fs.writeFileSync(k6Path, JSON.stringify(k6, null, 2));

    const p = await buildProjection(ws);
    expect(p.target_paths.k6).toBeUndefined();
    expect(p.run_commands.k6).toBeUndefined();
    expect((p.env_injection as Record<string, unknown>).k6).toBeUndefined();
    expect(p.artifact_paths.k6).toBeUndefined();
    expect(p.docker_base_images.k6).toBeUndefined();
    // Other tools remain.
    expect(p.target_paths.playwright_web).toBeDefined();
  });

  it('is order-independent — projection is identical across registry rebuilds', async () => {
    const a = await buildProjection(ws);
    const b = await buildProjection(ws);
    const strip = (p: PipelineProjection): string => {
      const clone = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
      (clone._generated as Record<string, unknown>).at = 'FIXED';
      return JSON.stringify(clone);
    };
    expect(strip(a)).toBe(strip(b));
  });
});
