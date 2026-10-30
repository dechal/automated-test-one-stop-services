#!/usr/bin/env node
// scripts/lib/rm-matching-dirs.mjs
//
// Remove directories whose basename matches one of --names, walking <root>
// recursively. Cross-platform, Node-core-only replacement for the GNU-only
// `find . -path ./.venv -prune -o ... -name X -exec rm -rf {} +` recipes used
// by the root `clean` and `clean-modules` tasks — `node` is a Core tool always
// on PATH, so it runs identically from cmd, PowerShell, and Git Bash.
//
// Rules (equivalent to the find pipelines they replace):
//   * a directory whose basename is in --prune is skipped — never entered,
//     never removed (honours the existing `.venv` / `node_modules` prune scope);
//   * a directory whose basename is in --names is removed (rm -rf semantics)
//     and NOT descended into (matches find's `-prune` after match);
//   * everything else is traversed.
//
// Note vs the original `-path ./.venv` (top-level only): pruning by NAME skips
// `.venv` / `node_modules` at ANY depth. That is equivalent-or-safer — artifacts
// nested INSIDE a dependency dir are intentionally left alone — and faster.
//
// Best-effort: a missing root and per-entry errors are swallowed (mirrors the
// `2>/dev/null || true` on the originals). Prints one `[rm] <path>` line per
// removed directory plus a short summary.
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @param {string[]} argv
 * @param {string} flag
 * @returns {Set<string>} comma-separated values following `flag`, trimmed
 */
function parseCsvFlag(argv, flag) {
  const i = argv.indexOf(flag);
  if (i === -1 || i + 1 >= argv.length) return new Set();
  return new Set(
    (argv[i + 1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * @param {string} root directory to walk
 * @param {Set<string>} names basenames to remove
 * @param {Set<string>} prune basenames to skip (not entered, not removed)
 * @returns {string[]} removed directory paths
 */
export function rmMatchingDirs(root, names, prune) {
  /** @type {string[]} */
  const removed = [];
  /** @param {string} dir */
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (prune.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (names.has(entry.name)) {
        try {
          rmSync(full, { recursive: true, force: true });
          removed.push(full);
        } catch {
          // best-effort — leave undeletable dirs in place
        }
        continue; // removed (or tried) — do not descend
      }
      walk(full);
    }
  };
  walk(root);
  return removed;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const root = argv[0];
  const names = parseCsvFlag(argv, '--names');
  const prune = parseCsvFlag(argv, '--prune');
  if (!root || names.size === 0) {
    console.error('usage: rm-matching-dirs.mjs <root> --names a,b,c [--prune x,y]');
    process.exit(2);
  }
  const removed = rmMatchingDirs(root, names, prune);
  for (const p of removed) console.log(`  [rm] ${p}`);
  console.log(
    removed.length === 0
      ? '  (nothing to remove)'
      : `  removed ${removed.length} director${removed.length === 1 ? 'y' : 'ies'}`,
  );
}
