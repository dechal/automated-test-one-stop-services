import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Workspace root (where the root Taskfile.yml lives). */
export const WORKSPACE_ROOT = path.resolve(here, '..', '..', '..');

export const TOOLS_DIR = path.join(WORKSPACE_ROOT, 'tools');
export const OUTPUTS_DIR = path.join(WORKSPACE_ROOT, 'outputs');
export const SCRIPTS_DIR = path.join(WORKSPACE_ROOT, 'scripts');

/**
 * Root of the `@hub/server` package (parent of `src/` in dev, of `dist/` in a
 * build). Commands that must resolve this package's own dependencies — e.g.
 * `pnpm exec playwright` for the trace viewer — spawn with this as their cwd.
 */
export const SERVER_PKG_DIR = path.join(here, '..');

/**
 * Directory holding Hub runtime data (the Local_DB file). Resolves to
 * `hub/server/data`.
 */
export const DATA_DIR = path.join(SERVER_PKG_DIR, 'data');

/**
 * Path to the embedded Local_DB (node:sqlite). Defaults to
 * `hub/server/data/hub.db`. Override with `HUB_DB_PATH` — set it to
 * `':memory:'` for an ephemeral DB (used by tests).
 */
export const LOCAL_DB_PATH = process.env.HUB_DB_PATH
  ? process.env.HUB_DB_PATH === ':memory:'
    ? ':memory:'
    : path.resolve(process.env.HUB_DB_PATH)
  : path.join(DATA_DIR, 'hub.db');

export const HOST = process.env.HUB_HOST || '127.0.0.1';
export const PORT = Number.parseInt(process.env.HUB_PORT || '5174', 10);

/**
 * Browser origins allowed to call the Hub API (CORS).
 *
 * The Hub is a LOCAL-ONLY tool bound to loopback (see HOST), so the realistic
 * threat is not a remote attacker but a malicious/compromised page open in the
 * SAME browser issuing cross-origin requests to 127.0.0.1 — on a server that
 * spawns `task`/git/credential commands, that is effectively CSRF→RCE. So we
 * allow only the known client origins instead of reflecting any origin
 * (`cors({ origin: true })`). Override/extend via HUB_ALLOWED_ORIGINS
 * (comma-separated). Defaults adapt to PORT so a custom HUB_PORT still works.
 */
export const ALLOWED_ORIGINS = process.env.HUB_ALLOWED_ORIGINS
  ? process.env.HUB_ALLOWED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : [
      'http://localhost:5173', // Vite dev client
      'http://127.0.0.1:5173',
      `http://localhost:${PORT}`, // production: client served from the server origin
      `http://127.0.0.1:${PORT}`,
    ];

/** Git Bash path for spawning shell commands that rely on POSIX shell semantics. */
export const BASH_PATH = (() => {
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'bash';
})();

/** Absolute path to a static client bundle (production). Empty in dev. */
export const CLIENT_DIST_DIR = process.env.HUB_CLIENT_DIST
  ? path.resolve(process.env.HUB_CLIENT_DIST)
  : path.join(here, '..', '..', 'client', 'dist');
