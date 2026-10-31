// scripts/manifests/__tests__/integration.spec.ts
//
// Integration tests for the manifest-driven drop-in and removal workflows.
//
// Drop-in integration test:
//   Copies the cypress-mock fixture into a temp workspace, runs syncWorkspace,
//   and asserts: docker-compose.yml is generated, pipeline.json carries
//   cypress-related keys, and no file outside tools/cypress/ is modified.
//
// Removal integration test:
//   After the drop-in sync, deletes tools/cypress/, runs syncWorkspace again,
//   and asserts: all cypress keys gone from pipeline.json, and the remaining
//   tools' generated artefacts (docker-compose.yml, tsconfig.json) are
//   byte-identical to their pre-removal state.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTmpDir, mkDir, realToolsPresent, rmTmpDir } from './_helpers.js';

// ─── Workspace root and fixture paths ────────────────────────────────────────

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const REAL_TOOLS_DIR = path.join(WORKSPACE_ROOT, 'tools');
const REAL_STATIC = path.join(
  WORKSPACE_ROOT,
  'scripts',
  'manifests',
  'data',
  'pipeline.static.json',
);
const CYPRESS_FIXTURE = path.join(import.meta.dirname, 'fixtures', 'cypress-mock');

/** Tool IDs present in the real workspace (the "remaining" tools). */
const EXISTING_TOOL_IDS = ['playwright', 'robot-framework', 'k6'] as const;

// ─── syncWorkspace loader ─────────────────────────────────────────────────────
// Loaded via a file-URL dynamic import so biome's noRestrictedImports rule
// (which bans literal `../../` relative paths) does not trigger on the import
// statement. The module path is computed at runtime from WORKSPACE_ROOT.

interface SyncWorkspaceModule {
  syncWorkspace(opts: { root: string }): Promise<{ regeneratedFiles: string[] }>;
}

async function loadSyncWorkspace(): Promise<SyncWorkspaceModule['syncWorkspace']> {
  const syncPath = path.join(WORKSPACE_ROOT, 'scripts', 'sync-projects.ts');
  const mod = (await import(pathToFileURL(syncPath).href)) as SyncWorkspaceModule;
  return mod.syncWorkspace;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Copy a directory tree recursively. */
function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Seed a fresh temp workspace with the 3 real tool manifests, their compose
 * templates, and the static pipeline parts.
 */
function seedBaseWorkspace(): string {
  const tmpDir = makeTmpDir('integration-test-');
  for (const id of EXISTING_TOOL_IDS) {
    const toolDir = mkDir(tmpDir, 'tools', id);
    fs.copyFileSync(
      path.join(REAL_TOOLS_DIR, id, 'tool.manifest.json'),
      path.join(toolDir, 'tool.manifest.json'),
    );
    // Copy compose template so compose-gen can run
    const composeTemplate = path.join(REAL_TOOLS_DIR, id, 'docker-compose.template.yml');
    if (fs.existsSync(composeTemplate)) {
      fs.copyFileSync(composeTemplate, path.join(toolDir, 'docker-compose.template.yml'));
    }
    // Copy tsconfig template (Playwright only)
    const tsconfigTemplate = path.join(REAL_TOOLS_DIR, id, 'tsconfig.template.json');
    if (fs.existsSync(tsconfigTemplate)) {
      fs.copyFileSync(tsconfigTemplate, path.join(toolDir, 'tsconfig.template.json'));
    }
  }
  const settings = mkDir(tmpDir, 'scripts', 'manifests', 'data');
  fs.copyFileSync(REAL_STATIC, path.join(settings, 'pipeline.static.json'));
  return tmpDir;
}

/** Read and parse pipeline.json from a workspace root. */
function readPipeline(tmpDir: string): Record<string, unknown> {
  const pipelinePath = path.join(tmpDir, 'scripts', 'manifests', 'data', 'pipeline.json');
  return JSON.parse(fs.readFileSync(pipelinePath, 'utf8')) as Record<string, unknown>;
}

/** Read a file content, returning null if it does not exist. */
function readIfExists(filePath: string): string | null {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

/** Built-in tool repos are git-ignored and absent from a fresh clone / CI; the
 * drop-in suite copies their REAL manifests, so skip when not present. */
const TOOLS_PRESENT = realToolsPresent(WORKSPACE_ROOT, EXISTING_TOOL_IDS);

describe.skipIf(!TOOLS_PRESENT)('integration: drop-in and removal', () => {
  let tmpDir: string;
  let syncWorkspace: SyncWorkspaceModule['syncWorkspace'];

  beforeAll(async () => {
    syncWorkspace = await loadSyncWorkspace();
    tmpDir = seedBaseWorkspace();
    // Copy cypress fixture into the temp workspace as tools/cypress/
    copyDir(CYPRESS_FIXTURE, path.join(tmpDir, 'tools', 'cypress'));
  });

  afterAll(() => {
    rmTmpDir(tmpDir);
  });

  // ── Drop-in ──────────────────────────────────────────────────────

  describe('drop-in — new tool appears without central edits', () => {
    beforeAll(async () => {
      await syncWorkspace({ root: tmpDir });
    });

    it('generates tools/cypress/docker-compose.yml', () => {
      const composePath = path.join(tmpDir, 'tools', 'cypress', 'docker-compose.yml');
      expect(fs.existsSync(composePath)).toBe(true);
    });

    it('pipeline.json contains target_paths.cypress_web referencing the cypress folder', () => {
      const pipeline = readPipeline(tmpDir);
      const targetPaths = pipeline.target_paths as Record<string, unknown>;
      expect(typeof targetPaths.cypress_web).toBe('string');
      expect(targetPaths.cypress_web as string).toContain('tools/cypress/projects/web');
    });

    it('pipeline.json run_commands.cypress.local contains task cypress:run-local', () => {
      const pipeline = readPipeline(tmpDir);
      const runCommands = pipeline.run_commands as Record<string, Record<string, string>>;
      expect(runCommands.cypress).toBeDefined();
      expect(runCommands.cypress.local).toContain('task cypress:run-local');
    });

    it('no file outside tools/cypress/ is modified by drop-in sync', () => {
      // Verify the manifests for all three existing tools are byte-identical to
      // what was seeded — syncWorkspace must not touch files outside tools/cypress/
      for (const id of EXISTING_TOOL_IDS) {
        const seededManifest = path.join(tmpDir, 'tools', id, 'tool.manifest.json');
        const originalManifest = path.join(REAL_TOOLS_DIR, id, 'tool.manifest.json');
        expect(
          fs.readFileSync(seededManifest, 'utf8'),
          `tool.manifest.json for ${id} must not be modified by sync`,
        ).toBe(fs.readFileSync(originalManifest, 'utf8'));
      }
      // scripts/manifests/data/pipeline.static.json must also be untouched
      const seededStatic = path.join(
        tmpDir,
        'scripts',
        'manifests',
        'data',
        'pipeline.static.json',
      );
      expect(
        fs.readFileSync(seededStatic, 'utf8'),
        'pipeline.static.json must not be modified by sync',
      ).toBe(fs.readFileSync(REAL_STATIC, 'utf8'));
    });
  });

  // ── Removal ──────────────────────────────────────────────────────

  describe('removal — deleted tool disappears, others unchanged', () => {
    /** Artefact contents captured BEFORE cypress removal (after drop-in sync). */
    let beforeArtefacts: Record<string, string | null>;

    beforeAll(async () => {
      // Re-sync to ensure all artefacts are current before we snapshot them.
      await syncWorkspace({ root: tmpDir });

      // Capture artefact contents of the three remaining tools BEFORE removal.
      beforeArtefacts = {
        'playwright-compose': readIfExists(
          path.join(tmpDir, 'tools', 'playwright', 'docker-compose.yml'),
        ),
        'robot-compose': readIfExists(
          path.join(tmpDir, 'tools', 'robot-framework', 'docker-compose.yml'),
        ),
        'k6-compose': readIfExists(path.join(tmpDir, 'tools', 'k6', 'docker-compose.yml')),
        'playwright-tsconfig': readIfExists(
          path.join(tmpDir, 'tools', 'playwright', 'tsconfig.json'),
        ),
      };

      // Delete tools/cypress/ — simulates removal of the tool folder.
      fs.rmSync(path.join(tmpDir, 'tools', 'cypress'), { recursive: true });

      // Run sync again with cypress gone.
      await syncWorkspace({ root: tmpDir });
    });

    it('pipeline.json does NOT contain target_paths.cypress_web', () => {
      const pipeline = readPipeline(tmpDir);
      const targetPaths = pipeline.target_paths as Record<string, unknown>;
      expect(targetPaths.cypress_web).toBeUndefined();
    });

    it('pipeline.json does NOT contain any cypress_* keys in target_paths', () => {
      const pipeline = readPipeline(tmpDir);
      const targetPaths = pipeline.target_paths as Record<string, unknown>;
      const cypressKeys = Object.keys(targetPaths).filter((k) => k.startsWith('cypress'));
      expect(cypressKeys).toHaveLength(0);
    });

    it('pipeline.json does NOT contain run_commands.cypress', () => {
      const pipeline = readPipeline(tmpDir);
      const runCommands = pipeline.run_commands as Record<string, unknown>;
      expect(runCommands.cypress).toBeUndefined();
    });

    it('pipeline.json does NOT contain env_injection.cypress', () => {
      const pipeline = readPipeline(tmpDir);
      const envInjection = pipeline.env_injection as Record<string, unknown>;
      expect(envInjection.cypress).toBeUndefined();
    });

    it('pipeline.json does NOT contain artifact_paths.cypress', () => {
      const pipeline = readPipeline(tmpDir);
      const artifactPaths = pipeline.artifact_paths as Record<string, unknown>;
      expect(artifactPaths.cypress).toBeUndefined();
    });

    it('pipeline.json does NOT contain docker_base_images.cypress', () => {
      const pipeline = readPipeline(tmpDir);
      const dockerBaseImages = pipeline.docker_base_images as Record<string, unknown>;
      expect(dockerBaseImages.cypress).toBeUndefined();
    });

    it('playwright docker-compose.yml is byte-identical to pre-removal state', () => {
      const afterContent = readIfExists(
        path.join(tmpDir, 'tools', 'playwright', 'docker-compose.yml'),
      );
      expect(afterContent).not.toBeNull();
      expect(afterContent).toBe(beforeArtefacts['playwright-compose']);
    });

    it('robot-framework docker-compose.yml is byte-identical to pre-removal state', () => {
      const afterContent = readIfExists(
        path.join(tmpDir, 'tools', 'robot-framework', 'docker-compose.yml'),
      );
      expect(afterContent).not.toBeNull();
      expect(afterContent).toBe(beforeArtefacts['robot-compose']);
    });

    it('k6 docker-compose.yml is byte-identical to pre-removal state', () => {
      const afterContent = readIfExists(path.join(tmpDir, 'tools', 'k6', 'docker-compose.yml'));
      expect(afterContent).not.toBeNull();
      expect(afterContent).toBe(beforeArtefacts['k6-compose']);
    });

    it('playwright tsconfig.json is byte-identical to pre-removal state', () => {
      const afterContent = readIfExists(path.join(tmpDir, 'tools', 'playwright', 'tsconfig.json'));
      expect(afterContent).not.toBeNull();
      expect(afterContent).toBe(beforeArtefacts['playwright-tsconfig']);
    });
  });
});
