#!/usr/bin/env node
// scripts/lib/list-git-dirs.mjs
//
// Print the path of every `.git` directory under <root> (recursively), one per
// line with forward slashes. Cross-platform, Node-core-only replacement for the
// GNU-only `find <root> -name .git -type d` used by the root `pull` task —
// `node` is a Core tool always on PATH, so it runs identically from cmd,
// PowerShell, and Git Bash.
//
// Forward-slash output is deliberate: the `pull` recipe pipes each path through
// `dirname` / `sed 's|tools/||'`, which expect POSIX separators on every shell.
//
// Skips `node_modules` / `.venv` (never project repos to pull) and does not
// descend into a discovered `.git` dir. Best-effort: unreadable dirs are
// skipped silently.
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SKIP = new Set(['node_modules', '.venv']);

/**
 * @param {string} root directory to walk (POSIX-style separators in output)
 * @returns {string[]} paths of every `.git` directory found
 */
export function listGitDirs(root) {
  /** @type {string[]} */
  const found = [];
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
      if (entry.name === '.git') {
        found.push(`${dir}/${entry.name}`);
        continue; // do not descend into a .git directory
      }
      if (SKIP.has(entry.name)) continue;
      walk(`${dir}/${entry.name}`);
    }
  };
  walk(root);
  return found;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const root = process.argv[2];
  if (!root) {
    console.error('usage: list-git-dirs.mjs <root>');
    process.exit(2);
  }
  for (const p of listGitDirs(root)) console.log(p);
}
