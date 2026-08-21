import path from 'node:path';
import type { CustomCommand } from '@hub/shared';
import { WORKSPACE_ROOT } from '../config.js';
import { isUnderWorkspace } from './path-guard.js';

/**
 * Build + validate the shell command for a CUSTOM schedule — a job that is not a
 * tool run (a seed script, a cleanup, a `git pull`, a `.bat`).
 *
 * Deliberately NOT part of `command-builder.ts`: that module's contract is
 * "every command comes from a tool manifest, with no tool literals in the Hub",
 * and a parity test holds it byte-for-byte against the interactive CLI runner. A
 * free-text command cannot participate in that guarantee, so it lives in its own
 * module and the tool path stays untouched.
 *
 * The Hub already runs arbitrary Taskfile code and is bound to loopback, so this
 * adds no new class of capability — but `cwd` is still fenced to the workspace so
 * a schedule cannot be pointed at the rest of the filesystem, and the check runs
 * at CREATE time (a rejection the user can see) rather than at 03:00 in a cron
 * tick where it would only reach a log.
 */

/** Rejection reason for an invalid custom command; `null` means valid. */
export type CustomCommandError =
  | { code: 'EMPTY_SCRIPT'; message: string }
  | { code: 'CWD_OUTSIDE_WORKSPACE'; message: string };

/**
 * Validate the user-supplied parts of a custom schedule.
 * @returns the error, or `null` when the command is acceptable
 */
export function validateCustomCommand(command: CustomCommand): CustomCommandError | null {
  if (command.script.trim().length === 0) {
    return { code: 'EMPTY_SCRIPT', message: 'The command to run cannot be empty' };
  }
  const cwd = command.cwd?.trim();
  if (cwd !== undefined && cwd.length > 0) {
    // Resolve relative to the workspace, which is also how the command will run.
    const resolved = path.resolve(WORKSPACE_ROOT, cwd);
    if (!isUnderWorkspace(resolved)) {
      return {
        code: 'CWD_OUTSIDE_WORKSPACE',
        message: `Working directory must stay inside the workspace: ${cwd}`,
      };
    }
  }
  return null;
}

/**
 * Compose the string handed to the runner. `cwd` becomes a `cd` prefix rather
 * than a spawn option because the runner owns spawning (and always spawns at the
 * workspace root) — keeping that single spawn path untouched is the point of the
 * additive design.
 *
 * Assumes {@link validateCustomCommand} already passed; it does not re-validate.
 */
export function buildCustomCommand(command: CustomCommand): string {
  const script = command.script.trim();
  const args = command.args?.trim();
  const full = args ? `${script} ${args}` : script;
  const cwd = command.cwd?.trim();
  if (!cwd) return full;
  // Single-quoted so a path with spaces survives; POSIX-quoted because the runner
  // spawns through bash on every platform.
  return `cd '${cwd.replace(/'/g, `'\\''`)}' && ${full}`;
}
