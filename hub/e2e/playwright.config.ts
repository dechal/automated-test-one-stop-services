import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(HERE, '..', '..');
const HUB_DIR = path.resolve(HERE, '..');
const CLIENT_DIST = path.resolve(
  process.env.HUB_E2E_CLIENT_DIST ??
    path.join(WORKSPACE_ROOT, '.cache', 'deletable', 'hub-e2e', 'client'),
);

function assertPrivateBuild(dir: string): void {
  const rel = path.relative(HUB_DIR, dir).split(path.sep);
  if (rel[0] !== '..' && rel.includes('dist')) {
    throw new Error(`hub e2e must not build into a live Hub dist folder: ${dir}`);
  }
}
assertPrivateBuild(CLIENT_DIST);

const now = new Date();
const RUN_DATE = [now.getMonth() + 1, now.getDate()]
  .map((n) => String(n).padStart(2, '0'))
  .concat(String(now.getFullYear()))
  .join('-');

/**
 * Hub client smoke config.
 *
 * Boots the BUILT Hub server (`hub/server/dist/index.js`) on its own port and
 * drives the built SPA, so it catches client-runtime regressions that vitest
 * cannot see (lazy chunk loading, merged CSS).
 *
 * Every path below is relative to this file's directory — Playwright resolves
 * `testDir`, `outputDir` and `webServer.cwd` against the config location.
 */

/**
 * Dedicated smoke port. A developer's own Hub listens on 5174, so this suite
 * never shares a port with it. Override with `HUB_E2E_PORT` / `HUB_E2E_HOST`.
 */
const PORT = Number.parseInt(process.env.HUB_E2E_PORT ?? '5199', 10);
const HOST = process.env.HUB_E2E_HOST ?? '127.0.0.1';

export default defineConfig({
  testDir: '.',
  // Failure artefacts land in the workspace-level, git-ignored outputs/ tree.
  outputDir: path.join(WORKSPACE_ROOT, 'outputs', 'others', RUN_DATE, 'hub-e2e'),
  fullyParallel: false,
  // One worker: the three specs share a single server process, and the suite is
  // short enough that parallel browsers only add startup cost.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  // The dashboard route waits on /api/doctor (environment probes) before it
  // paints, so first-paint assertions need more than the 5s default.
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://${HOST}:${PORT}`,
    headless: true,
    // Nothing recorded on a green run; artefacts appear only when something breaks.
    video: 'off',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // `pnpm run test:smoke` builds shared + server + client first.
    command: `pnpm -C ../client exec vite build --outDir "${CLIENT_DIST}" --emptyOutDir && pnpm exec tsx src/index.ts`,
    cwd: '../server',
    port: PORT,
    // Never adopt a Hub the developer is already running.
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      HUB_CLIENT_DIST: CLIENT_DIST,
      HUB_HOST: HOST,
      HUB_PORT: String(PORT),
      // Ephemeral DB — the smoke run must not write hub/server/data/hub.db.
      HUB_DB_PATH: ':memory:',
      NODE_ENV: 'production',
    },
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
