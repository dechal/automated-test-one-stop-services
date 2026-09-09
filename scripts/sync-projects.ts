// scripts/sync-projects.ts
//
// Synchronises workspace artefacts: .env files from templates, per-tool
// docker-compose.yml, per-tool tsconfig.json (Playwright), and the generated
// config/pipeline.json.
//
// Manifest-driven — iterates the manifest registry to generate all artefacts.
//
// PROGRAMMATIC ENTRY POINT:
//   `syncWorkspace({ root })` — used by the hub re-sync hook (Phase 5). Returns
//   `{ regeneratedFiles }` listing every file written during the run.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { generateDockerCompose } from './manifests/compose-gen.js';
import { createManifestRegistry, loadPipelineStatic, projectPipeline } from './manifests/index.js';
import { generateTsConfig } from './manifests/tsconfig-gen.js';
import type { ToolManifest } from './manifests/types.js';
import { syncUvWorkspaceMembers } from './manifests/uv-workspace-sync.js';
import { syncToolVersion } from './manifests/version-sync.js';

const currentDir =
  typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(currentDir, '..');

// ─── Shared: template syncing (tool-agnostic) ────────────────────────────────

/** Recursively copy `*.template.*` → `*.*` where the target does not yet exist. */
function syncRegularTemplates(dir: string): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (
        ![
          'node_modules',
          '.git',
          '.venv',
          'outputs',
          '.vscode',
          '.ruff_cache',
          '.robocop_cache',
          '.kiro',
        ].includes(entry.name) &&
        // Never materialize templates inside a *-template-example scaffold — it
        // ships as-is (only .env.template, not a generated .env). Consistent with
        // discover.ts / fs-helpers.isTemplate exclusion.
        !entry.name.endsWith('-template-example')
      ) {
        syncRegularTemplates(fullPath);
      }
    } else if (entry.isFile() && entry.name.includes('.template')) {
      // Skip templates that are handled dynamically by compose-gen / tsconfig-gen
      if (
        entry.name.includes('docker-compose.template.yml') ||
        entry.name.includes('tsconfig.template.json')
      )
        continue;

      const newFileName = entry.name.replace('.template', '');
      const newFilePath = path.join(dir, newFileName);

      if (!fs.existsSync(newFilePath)) {
        fs.copyFileSync(fullPath, newFilePath);
        console.log(`✅ Created: ${path.relative(rootDir, newFilePath)}`);
      }
    }
  }
}

// ─── Manifest path ───────────────────────────────────────────────────────────

const PIPELINE_JSON_PATH = path.join('config', 'pipeline.json');

/**
 * Run the manifest-driven sync at `workspaceRoot`. Generates per-tool
 * docker-compose.yml, per-tool tsconfig.json (when applicable), and the
 * unified `pipeline.json`.
 *
 * Returns the list of regenerated file paths (relative to `workspaceRoot`).
 */
async function runManifestSync(workspaceRoot: string): Promise<string[]> {
  const regeneratedFiles: string[] = [];

  syncRegularTemplates(workspaceRoot);

  const registry = createManifestRegistry(workspaceRoot);
  await registry.refresh();

  const knownManifests = registry
    .all()
    .map((record) => record.manifest)
    .filter((manifest): manifest is ToolManifest => manifest !== null);
  const uvFile = syncUvWorkspaceMembers(workspaceRoot, knownManifests);
  if (uvFile !== null) {
    regeneratedFiles.push(uvFile);
    console.log(`✅ uv workspace members ← tools present on disk → ${uvFile}`);
  }

  // Generate per-tool artefacts for enabled tools
  for (const tool of registry.enabled()) {
    const versionFile = syncToolVersion(workspaceRoot, tool);
    if (versionFile !== null) {
      regeneratedFiles.push(versionFile);
      console.log(`✅ ${tool.id} version ← its own pin → ${versionFile}`);
    }

    generateDockerCompose(workspaceRoot, tool);
    regeneratedFiles.push(
      path.relative(
        workspaceRoot,
        path.join(workspaceRoot, 'tools', tool.id, 'docker-compose.yml'),
      ),
    );

    if (tool.tsconfigGen !== null) {
      generateTsConfig(workspaceRoot, tool);
      regeneratedFiles.push(
        path.relative(
          workspaceRoot,
          path.join(workspaceRoot, 'tools', tool.id, tool.tsconfigGen.output),
        ),
      );
    }
  }

  // Emit pipeline.json
  const staticParts = loadPipelineStatic(workspaceRoot);
  const projection = projectPipeline(registry, staticParts);
  const pipelinePath = path.join(workspaceRoot, PIPELINE_JSON_PATH);
  fs.mkdirSync(path.dirname(pipelinePath), { recursive: true });
  fs.writeFileSync(pipelinePath, `${JSON.stringify(projection, null, 2)}\n`, 'utf8');
  regeneratedFiles.push(PIPELINE_JSON_PATH);
  console.log(`✅ pipeline.json → ${PIPELINE_JSON_PATH}`);

  // Surface broken manifests (do not throw)
  for (const record of registry.all()) {
    if (record.status === 'invalid') {
      const codes = record.errors.map((e) => e.code).join(', ');
      console.error(`⚠ Invalid manifest: ${record.path} [${codes}]`);
      for (const err of record.errors) {
        console.error(`   [${err.code}] ${err.message}`);
      }
    }
  }

  console.log('✨ Sync complete.');
  return regeneratedFiles;
}

// ─── Programmatic entry point (hub re-sync hook, Phase 5) ─────────────────────

export interface SyncWorkspaceOptions {
  root: string;
}

export interface SyncWorkspaceResult {
  regeneratedFiles: string[];
}

/**
 * Programmatic entry point for workspace synchronisation. Used by the hub
 * server's `withResync(...)` wrapper so lifecycle events (enable / disable /
 * install / uninstall / update) regenerate artefacts in-process.
 */
export async function syncWorkspace(options: SyncWorkspaceOptions): Promise<SyncWorkspaceResult> {
  const regeneratedFiles = await runManifestSync(options.root);
  return { regeneratedFiles };
}

// ─── Script entry point ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🔄 Synchronising templates...');
  await runManifestSync(rootDir);
}

// Only auto-run when invoked as a CLI entry (`tsx scripts/sync-projects.ts`).
// When the hub imports this module in-process for the `syncWorkspace` export
// (workspace-sync.ts → withResync), we must NOT run main() — otherwise the sync
// fires twice per lifecycle mutation.
const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
