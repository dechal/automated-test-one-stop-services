#!/usr/bin/env node
// ============================================================================
//  setup-state.mjs — canonical setup-state.json reader/writer for the shell
//  Setup_Bootstrap scripts (setup-windows.bat / setup-linux.sh).
//
//  Ledger shape: { "steps": { <name>: "pending" | "done" | "failed" }, "updatedAt": ISO }
//  with STEP_ORDER = node, pnpm, uv, task, install-deps, start-hub.
//  (k6 is NOT a Core step — it is provisioned by the k6 tool's own setup task,
//   folder-presence gated.
//   The Hub runs as a daemonless background process — optionally supervised by
//   systemd --user / launchd — so no process manager is a Core install step.)
//
//  The shell scripts shell out to this once node exists (node is the first
//  tool installed) so the canonical ledger is always written by the same JSON
//  logic the Hub uses. Before node exists, the scripts fall back to a plain
//  text/findstr writer that emits the identical flat shape.
//
//  Usage:
//    node setup-state.mjs read  <stateFile>
//        → prints "<step>:<status>" lines for every step in STEP_ORDER
//          (status defaults to "pending" when absent/invalid). Designed to be
//          consumed by a `for /f "tokens=1,2 delims=:"` loop in .bat and a
//          `while IFS=:` loop in bash.
//
//    node setup-state.mjs write <stateFile> name=status [name=status ...]
//        → merges the given step statuses onto whatever is already on disk and
//          writes the file atomically (tmp + rename). Empty status is coerced
//          to "pending". Unknown statuses are coerced to "pending".
//          Exit code is always 0 on success.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STEP_ORDER = ['node', 'pnpm', 'uv', 'task', 'install-deps', 'start-hub'];
const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STATE_FILE_NAME = 'setup-state.json';
export const DEFAULT_STATE_FILE = path.join(WORKSPACE_ROOT, '.cache', 'state', STATE_FILE_NAME);
export const LEGACY_STATE_FILE = path.join(WORKSPACE_ROOT, '.setup-state.json');
/**
 * Move a legacy ledger onto `stateFile` when `stateFile` is absent, so a
 * machine set up before the move keeps its "done" steps. Returns true on move.
 */
export function migrateLegacyState(stateFile, legacyFile = LEGACY_STATE_FILE) {
  const target = path.resolve(stateFile);
  const legacy = path.resolve(legacyFile);
  if (target === legacy || fs.existsSync(target) || !fs.existsSync(legacy)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(legacy, target);
  return true;
}
function migrateIfDefault(stateFile) {
  migrateLegacyState(stateFile, path.join(path.dirname(stateFile), '.setup-state.json'));
  if (path.resolve(stateFile) === DEFAULT_STATE_FILE) migrateLegacyState(stateFile);
}

const VALID = new Set(['pending', 'done', 'failed']);

/** Coerce any value to a valid status, defaulting to "pending". */
export function coerce(value) {
  return VALID.has(value) ? value : 'pending';
}

/**
 * Read the ledger, tolerating a missing/corrupt file by returning an empty
 * step map (this .mjs is the canonical ledger reader/writer). Unknown statuses
 * are dropped here and surfaced as "pending" by the caller.
 */
export function readState(stateFile) {
  let raw;
  try {
    raw = fs.readFileSync(stateFile, 'utf8');
  } catch {
    return { steps: {}, updatedAt: new Date().toISOString() };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') {
      return { steps: {}, updatedAt: new Date().toISOString() };
    }
    const steps = {};
    if (parsed.steps && typeof parsed.steps === 'object') {
      for (const [key, value] of Object.entries(parsed.steps)) {
        if (VALID.has(value)) steps[key] = value;
      }
    }
    const updatedAt =
      typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString();
    return { steps, updatedAt };
  } catch {
    return { steps: {}, updatedAt: new Date().toISOString() };
  }
}

/**
 * Sleep synchronously for `ms` without busy-spinning — `Atomics.wait` on a
 * throwaway SharedArrayBuffer. Used to back off between rename retries below.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** errno codes a Windows file lock (antivirus/indexer/parallel writer) raises. */
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

/**
 * Atomically persist the ledger (tmp file + rename) so a crash never corrupts
 * it. On Windows the final rename over an existing file can transiently fail
 * with EPERM/EBUSY/EACCES when an antivirus/indexer (or, in tests, a parallel
 * writer) briefly holds the destination handle. `fs.renameSync` has NO built-in
 * retry (unlike `fs.rmSync`'s `maxRetries`), so we retry with linear backoff
 * before giving up — both the real installer and the property tests hammer this
 * path on Windows.
 */
export function writeState(stateFile, steps) {
  const persisted = { steps, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(path.resolve(stateFile)), { recursive: true });
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, stateFile);
      return;
    } catch (err) {
      if (attempt >= 9 || !TRANSIENT_RENAME_ERRORS.has(err?.code)) throw err;
      sleepSync(50 * (attempt + 1)); // 50,100,…,450ms — <=2.25s total, under the hook timeout
    }
  }
}

/**
 * Resume selector: the first step in STEP_ORDER whose recorded status is not
 * "done" (the step a re-run resumes from), or null when every step is done.
 * Statuses are coerced, so an absent/invalid entry counts as not-done. This is
 * the canonical "where do I resume?" rule the bootstrap scripts rely on for a
 * re-runnable partial install; every step before it is "done".
 */
export function selectResumeStep(steps) {
  const map = steps && typeof steps === 'object' ? steps : {};
  for (const step of STEP_ORDER) {
    if (coerce(map[step]) !== 'done') return step;
  }
  return null;
}

function cmdRead(stateFile) {
  const state = readState(stateFile);
  for (const step of STEP_ORDER) {
    process.stdout.write(`${step}:${coerce(state.steps[step])}\n`);
  }
}

function cmdWrite(stateFile, pairs) {
  // Start from the on-disk state so a partial write preserves prior steps.
  const current = readState(stateFile);
  const steps = {};
  for (const step of STEP_ORDER) steps[step] = coerce(current.steps[step]);
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq);
    const status = pair.slice(eq + 1);
    if (STEP_ORDER.includes(name)) steps[name] = coerce(status);
  }
  writeState(stateFile, steps);
}

function main() {
  const [, , mode, stateFile, ...rest] = process.argv;
  if (!mode || !stateFile) {
    process.stderr.write('usage: setup-state.mjs <read|write> <stateFile> [name=status ...]\n');
    process.exit(2);
  }
  migrateIfDefault(stateFile);
  if (mode === 'read') {
    cmdRead(stateFile);
  } else if (mode === 'write') {
    cmdWrite(stateFile, rest);
  } else {
    process.stderr.write(`unknown mode: ${mode}\n`);
    process.exit(2);
  }
}

// Execute the CLI only when run directly (node setup-state.mjs <mode> ...). When
// imported by a test the exported pure helpers above are used directly, so the
// argv guard keeps main() (and its process.exit) from firing under the runner.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
