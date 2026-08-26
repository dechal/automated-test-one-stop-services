// scripts/install-core/prune-browsers.ts
//
// Prune STALE Playwright browser builds from PLAYWRIGHT_BROWSERS_PATH, keeping
// the revision the installed `@playwright/test` requires. `playwright install`
// never removes old builds, so after an upgrade the cache accumulates them
// (e.g. `chromium-1217` lingers next to `chromium-1234`). `playwright uninstall`
// only offers all-or-current, not "keep current, drop the rest" — hence this.
//
// Same shape as provision.ts: the selection is a PURE function so the runtime
// and its test share one source of truth; the CLI just does the fs I/O. The
// expected revisions come from playwright-core's `browsers.json` (the same table
// `playwright install --dry-run` reads) — zero-config, no spawn.

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** One `browsers.json` entry (only the fields we use). */
interface BrowsersJsonEntry {
  name: string;
  revision: string;
  installByDefault?: boolean;
  revisionOverrides?: Record<string, string>;
}

/** Repo root = two levels up from scripts/install-core/. */
function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** The browser cache dir: PLAYWRIGHT_BROWSERS_PATH (resolved against root so a
 *  relative value works), else the workspace-local `<root>/.cache/...`. */
export function resolveBrowsersRoot(): string {
  const root = repoRoot();
  const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
  return env ? path.resolve(root, env) : path.join(root, '.cache', 'playwright-browsers');
}

/** Locate playwright-core's `browsers.json` for the pinned @playwright/test,
 *  without spawning. Returns undefined if it cannot be resolved. */
export function resolveBrowsersJsonPath(): string | undefined {
  const toolDir = path.join(repoRoot(), 'tools', 'playwright');
  const pnpmDir = path.join(toolDir, 'node_modules', '.pnpm');
  try {
    const pkg = JSON.parse(readFileSync(path.join(toolDir, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const spec =
      pkg.devDependencies?.['@playwright/test'] ?? pkg.dependencies?.['@playwright/test'];
    const version = spec?.replace(/^[^0-9]*/, '');
    if (version) {
      const p = path.join(
        pnpmDir,
        `playwright-core@${version}`,
        'node_modules',
        'playwright-core',
        'browsers.json',
      );
      if (existsSync(p)) return p;
    }
  } catch {
    // fall through to scan
  }
  try {
    const entry = readdirSync(pnpmDir).find((e) => e.startsWith('playwright-core@'));
    if (entry) {
      const p = path.join(pnpmDir, entry, 'node_modules', 'playwright-core', 'browsers.json');
      if (existsSync(p)) return p;
    }
  } catch {
    // unresolved
  }
  return undefined;
}

/** Map of on-disk folder base name → the set of revisions that are acceptable
 *  for it (the required revision plus any per-OS webkit overrides). Only
 *  install-by-default browsers are tracked. Folder bases use `_` where the
 *  browser name uses `-` (e.g. `chromium-headless-shell` → `chromium_headless_shell`). */
export function expectedRevisions(browsers: BrowsersJsonEntry[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const b of browsers) {
    if (!b.installByDefault) continue;
    const base = b.name.replace(/-/g, '_');
    map.set(base, new Set<string>([b.revision, ...Object.values(b.revisionOverrides ?? {})]));
  }
  return map;
}

/** Group installed folder names by base → set of revisions. Ignores dotfiles
 *  and anything not shaped `<base>-<digits>`. */
export function parseInstalled(entries: string[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const dash = entry.lastIndexOf('-');
    if (dash <= 0) continue;
    const rev = entry.slice(dash + 1);
    if (!/^\d+$/.test(rev)) continue;
    const base = entry.slice(0, dash);
    const revs = map.get(base) ?? new Set<string>();
    revs.add(rev);
    map.set(base, revs);
  }
  return map;
}

/**
 * The folder names to delete: for every TRACKED browser base, each installed
 * revision that is not in its accept set. Untracked bases (e.g. `winldd`) are
 * left alone so we never delete something we do not understand. Pure — the
 * unit test drives it without the filesystem.
 */
export function foldersToPrune(
  installed: Map<string, Set<string>>,
  expected: Map<string, Set<string>>,
): string[] {
  const prune: string[] = [];
  for (const [base, revs] of installed) {
    const accept = expected.get(base);
    if (!accept) continue; // untracked → never prune
    for (const rev of revs) {
      if (!accept.has(rev)) prune.push(`${base}-${rev}`);
    }
  }
  return prune.sort();
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  const browsersRoot = resolveBrowsersRoot();

  if (!existsSync(browsersRoot)) {
    process.stdout.write(`prune-browsers: no cache at ${browsersRoot} — nothing to do.\n`);
    return;
  }
  const jsonPath = resolveBrowsersJsonPath();
  if (!jsonPath) {
    process.stderr.write(
      'prune-browsers: could not resolve playwright-core/browsers.json — is tools/playwright installed? Aborting (nothing removed).\n',
    );
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(jsonPath, 'utf8')) as { browsers?: BrowsersJsonEntry[] };
  const expected = expectedRevisions(data.browsers ?? []);
  const installed = parseInstalled(readdirSync(browsersRoot));
  const prune = foldersToPrune(installed, expected);

  if (prune.length === 0) {
    process.stdout.write('prune-browsers: no stale browser builds — cache is clean.\n');
    return;
  }

  for (const name of prune) {
    const target = path.join(browsersRoot, name);
    if (dryRun) {
      process.stdout.write(`  [would remove] ${name}\n`);
      continue;
    }
    try {
      rmSync(target, { recursive: true, force: true });
      process.stdout.write(`  [rm] ${name}\n`);
    } catch {
      // best-effort — leave locked builds in place
    }
  }
  process.stdout.write(
    dryRun
      ? `prune-browsers: ${prune.length} stale build(s) would be removed (dry run).\n`
      : `prune-browsers: removed ${prune.length} stale build(s) from ${browsersRoot}.\n`,
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
