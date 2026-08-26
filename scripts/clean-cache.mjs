#!/usr/bin/env node
// scripts/clean-cache.mjs
//
// Safe, category-aware cleaner for the workspace scratch cache `<root>/.cache/`.
// `.cache/` is git-ignored throwaway space shared by every tool, the Hub, the
// AI layer and ad-hoc debugging — so "just delete it" is unsafe: it also holds
// the Playwright browser binaries (deleting them forces a multi-minute
// re-download) and the brain retrieval index.
//
// The cache is organised by DELETABILITY (see steering `cache-scratch`):
//   .cache/deletable/    → definitely disposable; AI/tools write scratch here.
//   .cache/regenerable/  → caches that rebuild themselves (slower first run).
//   <protected names>    → NEVER auto-deleted (see PROTECTED below). These are
//                          path-locked (workspace code resolves them by a fixed
//                          path) so they cannot move into a category folder.
//
// Modes (compose freely):
//   (default)        remove the CONTENTS of .cache/deletable/
//   --deep           also remove the contents of .cache/regenerable/
//   --root-scratch   also remove loose .cache/* entries that are neither a
//                    category folder nor PROTECTED (the legacy pre-convention mess)
//   --dry-run        print what WOULD be removed, delete nothing
//
// Safety invariants: never deletes a PROTECTED name; never touches anything
// outside `.cache/`; every target is re-checked to be inside `.cache/` before
// removal. Node-core only, so it runs identically from cmd/PowerShell/Git Bash.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Names under `.cache/` that must never be auto-deleted. Path-locked runtime
 *  assets + the category folders themselves. */
const PROTECTED = new Set([
  'playwright-browsers', // browser binaries — deleting = full re-download; path-locked
  'deletable', // category folder (its CONTENTS are cleared, the folder stays)
  'regenerable', // category folder (holds brain-auto-retrieve etc; cleared only on --deep)
]);

const CATEGORY_DIRS = ['deletable', 'regenerable'];

/** Repo root = parent of scripts/. `.cache` lives directly under it. */
export function cacheRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache');
}

/** True when `target` is strictly inside `root` (guards against a stray abs path). */
function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Compute the absolute paths a run would remove, given the cache root, the
 * present entries, and the flags. Pure (takes the directory listing as input)
 * so the selection logic is unit-testable without touching the filesystem.
 *
 * @param {string} root absolute path to `.cache`
 * @param {(dir: string) => string[]} list readdir for a given absolute dir
 * @param {{ deep?: boolean; rootScratch?: boolean }} flags
 * @returns {string[]} absolute paths to remove
 */
export function selectTargets(root, list, flags) {
  const targets = [];
  const categoriesToClear = flags.deep ? ['deletable', 'regenerable'] : ['deletable'];
  for (const cat of categoriesToClear) {
    const dir = path.join(root, cat);
    for (const name of list(dir)) targets.push(path.join(dir, name));
  }
  if (flags.rootScratch) {
    for (const name of list(root)) {
      if (PROTECTED.has(name)) continue;
      targets.push(path.join(root, name));
    }
  }
  // De-dupe and keep only paths genuinely inside `.cache/`.
  return [...new Set(targets)].filter((t) => isInside(root, t));
}

/** readdir that returns [] for a missing/unreadable dir. */
function safeList(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * `--tidy` (the cache-tidy Stop hook): MOVE loose `.cache/` root entries that are
 * neither a tier folder nor a PROTECTED asset into `.cache/deletable/`, so a
 * convention-violating write to the root is swept back into the disposable tier
 * without losing the data (it is renamed, not deleted). Only root strays are
 * touched — a file correctly written under `deletable/` is never moved, so an
 * agent that follows the convention is unaffected. Silent + never throws (a Stop
 * hook must not fail a turn). Kill switch: CACHE_TIDY=off.
 */
function tidyRootScratch(root) {
  if (process.env.CACHE_TIDY === 'off') return;
  const dest = path.join(root, 'deletable');
  mkdirSync(dest, { recursive: true });
  let moved = 0;
  for (const name of safeList(root)) {
    if (PROTECTED.has(name)) continue;
    const from = path.join(root, name);
    if (!isInside(root, from)) continue;
    let to = path.join(dest, name);
    if (existsSync(to)) to = path.join(dest, `${name}.${Date.now()}`);
    try {
      renameSync(from, to);
      moved += 1;
    } catch {
      // locked / in-use / cross-device — leave it, try again next turn
    }
  }
  if (moved > 0) {
    console.log(
      `clean-cache --tidy: moved ${moved} stray entr${moved === 1 ? 'y' : 'ies'} into deletable/.`,
    );
  }
}

function main() {
  const argv = process.argv.slice(2);
  const flags = {
    deep: argv.includes('--deep'),
    rootScratch: argv.includes('--root-scratch'),
    dryRun: argv.includes('--dry-run'),
    tidy: argv.includes('--tidy'),
  };
  const root = cacheRoot();

  // Ensure the category folders always exist so the convention self-heals.
  for (const cat of CATEGORY_DIRS) mkdirSync(path.join(root, cat), { recursive: true });

  // --tidy (Stop hook): sweep root strays into deletable/, then stop. Never deletes.
  if (flags.tidy) {
    tidyRootScratch(root);
    return;
  }

  if (!existsSync(root)) {
    console.log('clean-cache: no .cache/ directory — nothing to do.');
    return;
  }

  const targets = selectTargets(root, safeList, flags);
  if (targets.length === 0) {
    console.log('clean-cache: nothing to remove (deletable/ empty).');
    return;
  }

  let removed = 0;
  for (const target of targets) {
    if (!isInside(root, target) || PROTECTED.has(path.basename(target))) continue; // belt + braces
    if (flags.dryRun) {
      const kind = statSync(target).isDirectory() ? 'dir ' : 'file';
      console.log(`  [would remove] ${kind} ${path.relative(root, target)}`);
      continue;
    }
    try {
      rmSync(target, { recursive: true, force: true });
      removed += 1;
      console.log(`  [rm] ${path.relative(root, target)}`);
    } catch {
      // best-effort — leave locked entries in place
    }
  }
  console.log(
    flags.dryRun
      ? `clean-cache: ${targets.length} entr${targets.length === 1 ? 'y' : 'ies'} would be removed (dry run).`
      : `clean-cache: removed ${removed} entr${removed === 1 ? 'y' : 'ies'} from .cache/.`,
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
