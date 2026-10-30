#!/usr/bin/env node
// scripts/lib/usage-log.mjs
//
// Fire the best-effort Google Sheet usage log for a run. This is the SINGLE
// shared entry point used by BOTH the interactive CLI runner
// (scripts/runner.ts) and the Hub run service
// (hub/server/src/services/runner.ts), so the two never drift (approach A: the
// run flow owns usage logging — the task layer does not).
//
// It spawns the logging script through dotenvx so scripts/.env (SPREADSHEET_ID,
// SHEET_NAME) is loaded uniformly regardless of the caller's own environment.
// The logging script itself is best-effort: not-configured / bad token /
// network error all degrade to a warn + clean exit, and auth is
// non-interactive (it refreshes the stored Google token silently and NEVER
// opens a browser mid-run). This helper mirrors that contract — it NEVER throws
// and NEVER rejects, so a logging hiccup can neither fail nor block a test run.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(HERE, '..', '..');
const LOG_SCRIPT = 'scripts/third-party/google/google-sheet-usage-log.ts';
// Bound the whole best-effort attempt so a hung network call can never delay a
// run for long. Silent-skip cases (not configured / bad token) return well under this.
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Current date/time in Asia/Bangkok as the run-folder convention expects:
 * date `YYYY-MM-DD`, time `HH-MM-SS` (dashes; the log script re-displays it as
 * `HH:MM:SS`). Used only as a fallback when the caller's env has not already
 * set CURRENT_DATE / CURRENT_TIME (the CLI inherits them from the Taskfile).
 */
function bangkokDateTime() {
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(now)
    .replace(/:/g, '-');
  return { date, time };
}

/**
 * Fire the usage log. Always resolves (best-effort); never throws/rejects.
 *
 * @param {object} [opts]
 * @param {string} [opts.command]   The executed command, for the sheet's "command" column.
 * @param {string} [opts.channel]   Origin channel: "local" (CLI) or "hub". Default "local".
 * @param {string} [opts.cwd]       Working dir to spawn from. Default workspace root.
 * @param {boolean} [opts.inheritStdio] Show the script's [usage-log] output (CLI). Default false.
 * @param {number} [opts.timeoutMs] Hard cap on the attempt. Default 20_000.
 * @returns {Promise<void>}
 */
export function runUsageLog(opts = {}) {
  const { command, channel, cwd, inheritStdio = false, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  // Unit tests (Hub runner suite) mock node:child_process.spawn; firing a real
  // external side-effect there is neither wanted nor deterministic. Skip under
  // Vitest — real CLI/Hub runs (never under Vitest) are unaffected.
  if (process.env.VITEST) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const { date, time } = bangkokDateTime();
    const env = { ...process.env };
    if (command) env.COMMAND = command;
    env.CHANNEL = channel ?? env.CHANNEL ?? 'local';
    if (!env.CURRENT_USER) env.CURRENT_USER = os.userInfo().username;
    if (!env.CURRENT_DATE) env.CURRENT_DATE = date;
    if (!env.CURRENT_TIME) env.CURRENT_TIME = time;

    let child;
    try {
      // dotenvx + tsx resolve from PATH (Volta shims), exactly like the Taskfile.
      // dotenvx loads scripts/.env (SPREADSHEET_ID / SHEET_NAME) into the child.
      child = spawn(
        'pnpm',
        ['exec', 'dotenvx', 'run', '--quiet', '-f', './scripts/.env', '--', 'tsx', LOG_SCRIPT],
        {
          cwd: cwd ?? WORKSPACE_ROOT,
          env,
          shell: true,
          windowsHide: true,
          stdio: inheritStdio ? 'inherit' : 'ignore',
        },
      );
    } catch {
      // spawn itself threw (e.g. shell missing) — best-effort, just skip.
      done();
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      done();
    }, timeoutMs);
    // Never let this timer keep the process alive.
    timer.unref?.();

    child.on('error', () => {
      clearTimeout(timer);
      done();
    });
    child.on('close', () => {
      clearTimeout(timer);
      done();
    });
  });
}
