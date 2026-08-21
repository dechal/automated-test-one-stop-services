/**
 * Recover the FAILING TASK's exit code from `task` (go-task) output.
 *
 * Every Hub run is spawned as `task <ns>:run-…`, so the exit code the runner
 * records is go-task's OWN process code. go-task returns a fixed `201` for any
 * task failure regardless of what the task's shell exited with, so the panel's
 * "Exit code: 201" says nothing about the tool that actually ran — a k6 threshold
 * breach (99), a Playwright test failure (1) and a broken command all look the
 * same. go-task does print the inner code, on stderr:
 *
 *   task: Failed to run task "k6:run-local": task: Failed to run task "k6:_move-results": exit status 99
 *
 * That is a stable part of go-task's output (verified against 3.51.1), so it is
 * parsed rather than guessed. Nested task chains repeat the prefix; the code at
 * the END of the line is the innermost one, which is the tool's.
 */

/** go-task's generic "a task failed" process code — never a tool's own code. */
export const TASK_RUNNER_FAILURE_CODE = 201;

/**
 * Innermost `exit status <N>` reported by go-task, or `null` when the output
 * carries no such line (the run was cancelled, or the failure came from the
 * shell before task started).
 */
export function parseTaskExitCode(raw: string): number | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
  const text = raw.replace(/\x1b\[[0-9;]*m/g, '');
  const matches = [...text.matchAll(/Failed to run task[^\n]*?exit status (\d+)/g)];
  const last = matches.at(-1);
  if (!last) return null;
  const code = Number.parseInt(last[1] ?? '', 10);
  return Number.isInteger(code) ? code : null;
}

/**
 * How to label a finished run's exit code. Returns the tool's code plus the
 * runner's when they differ, so nothing is hidden from the user:
 *   `99 (task 201)`  ·  `1`  ·  `N/A`
 *
 * @param exitCode code the runner recorded (go-task's)
 * @param output   the run's buffered output, searched for the inner code
 */
export function formatExitCode(exitCode: number | null | undefined, output: string): string {
  if (exitCode === null || exitCode === undefined) return 'N/A';
  if (exitCode !== TASK_RUNNER_FAILURE_CODE) return String(exitCode);
  const inner = parseTaskExitCode(output);
  if (inner === null || inner === exitCode) return String(exitCode);
  return `${inner} (task ${exitCode})`;
}
