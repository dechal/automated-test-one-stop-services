#!/usr/bin/env node
// scripts/lib/child-exit-code.mjs
//
// Recover the REAL exit code of a command that ran under `dotenvx run`.
//
// Why this exists: `dotenvx run -- <cmd>` does NOT forward its child's exit code.
// Any non-zero child makes dotenvx itself exit 126, and the child's own code
// survives only as a stderr line:
//
//   ☠ Command failed with exit code 99: C:\...\k6.EXE run ./...
//
// Verified 2026-08-21: `dotenvx run -f <env> -- node -e "process.exit(99)"` leaves
// the shell with 126. Downstream that flattens every failure into one code, so a
// k6 threshold breach (99) becomes indistinguishable from a real error, and CI
// sees a shell-ish 126 for a perfectly ordinary failed test run.
//
// The run pipelines already `tee` the child's output to a log, so the real code is
// on disk. This reads it back. Node-core only (`grep`/`sed` are go-task builtins
// whose failure aborts the whole cmds block, so they must not be used here).
//
// Usage:
//   node scripts/lib/child-exit-code.mjs <logfile> <observed-exit-code>
//
// Prints ONE integer on stdout — always, so the caller can assign it
// unconditionally. Never throws, never exits non-zero:
//   - observed code is 0            -> 0 (success needs no recovery)
//   - observed code is not 126      -> the observed code, unchanged
//   - 126 + a parseable log line    -> the child's real code
//   - 126 + nothing to parse        -> 126 (kept, so a failure stays a failure)
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** dotenvx's own code for "the child failed"; not a code any test tool returns. */
export const DOTENVX_WRAPPED_FAILURE = 126;

/**
 * Last `Command failed with exit code <N>` in `text`, or null.
 *
 * LAST, not first: a looping runner can append several attempts to one log, and
 * the caller is reporting the attempt that just finished.
 * @param {string} text log contents
 * @returns {number | null}
 */
export function parseChildExitCode(text) {
  const matches = [...text.matchAll(/Command failed with exit code (\d+)/g)];
  const last = matches.at(-1);
  if (!last) return null;
  const code = Number.parseInt(last[1] ?? '', 10);
  return Number.isInteger(code) ? code : null;
}

/**
 * Resolve the code to report for a child that ran under `dotenvx run`.
 * @param {string} logPath file the child's output was tee'd to
 * @param {number} observed exit code the shell saw (dotenvx's own)
 * @returns {number}
 */
export function resolveChildExitCode(logPath, observed) {
  if (observed === 0) return 0;
  if (observed !== DOTENVX_WRAPPED_FAILURE) return observed;
  let text;
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    return observed; // no log (cancelled early, wrong path) — keep the failure
  }
  return parseChildExitCode(text) ?? observed;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [logPath, observedRaw] = process.argv.slice(2);
  const observed = Number.parseInt(observedRaw ?? '', 10);
  if (!logPath || !Number.isInteger(observed)) {
    // Malformed invocation must not mint a "pass": fall back to the wrapped code.
    console.error('usage: child-exit-code.mjs <logfile> <observed-exit-code>');
    process.stdout.write(String(DOTENVX_WRAPPED_FAILURE));
  } else {
    process.stdout.write(String(resolveChildExitCode(logPath, observed)));
  }
}
