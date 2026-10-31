// scripts/manifests/__tests__/_helpers.ts
//
// Shared test utilities for the manifest-foundation unit tests.
// Provides a deep-cloned valid manifest builder (sourced from the committed
// `fixtures/valid-minimal.json`) plus temp-workspace scaffolding helpers used by
// the discovery and fs-helper specs.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures');

/** Parse a JSON fixture file from the `fixtures/` folder. */
export function readFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

/**
 * A fresh, structurally-valid manifest as a plain object. Each call returns a
 * deep clone so mutations in one test never leak into another.
 */
export function baseManifest(): Record<string, unknown> {
  return structuredClone(readFixture('valid-minimal.json')) as Record<string, unknown>;
}

/** Create an isolated temp directory; returns its absolute path. */
export function makeTmpDir(prefix = 'manifests-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Recursively remove a temp directory, ignoring errors. Uses `maxRetries`/
 * `retryDelay` so transient Windows locks (Defender/indexer scanning the
 * freshly-created temp files) during the recursive delete are ridden out with
 * backoff instead of hanging the `afterEach` hook — the cause of the flaky
 * "Hook timed out" failures when test files run in parallel.
 */
export function rmTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * True only when EVERY given built-in tool id has a `tool.manifest.json` on disk
 * under `<workspaceRoot>/tools/`. The built-in tools live in their own,
 * git-ignored repositories (see `scripts/manifests/data/tool-registry.json`), so they
 * are ABSENT from a fresh `git clone` / a CI checkout. Integration specs that
 * read the real manifests use this to `skipIf(!present)` instead of failing
 * with ENOENT where the tools were never provisioned.
 */
export function realToolsPresent(workspaceRoot: string, ids: readonly string[]): boolean {
  return ids.every((id) =>
    fs.existsSync(path.join(workspaceRoot, 'tools', id, 'tool.manifest.json')),
  );
}

/** Create a directory (recursively). Returns the created path. */
export function mkDir(...segments: string[]): string {
  const target = path.join(...segments);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

/** Write a tool manifest file into `<workspace>/tools/<id>/tool.manifest.json`. */
export function writeToolManifest(
  workspaceRoot: string,
  id: string,
  contents: unknown = { schemaVersion: '1', id },
): string {
  const dir = mkDir(workspaceRoot, 'tools', id);
  const file = path.join(dir, 'tool.manifest.json');
  fs.writeFileSync(file, JSON.stringify(contents, null, 2));
  return file;
}
