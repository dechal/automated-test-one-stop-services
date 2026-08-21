import { formatExitCode, parseTaskExitCode, TASK_RUNNER_FAILURE_CODE } from '@hub/shared';
import { describe, expect, it } from 'vitest';

/**
 * go-task returns a fixed 201 for any task failure, so the runner's recorded exit
 * code hides the tool's. These pin the recovery of the inner code from go-task's
 * own stderr line (format verified against go-task 3.51.1).
 */
describe('parseTaskExitCode', () => {
  const nested =
    'task: Failed to run task "k6:run-local": task: Failed to run task "k6:_move-results": exit status 99';

  it('takes the innermost code from a nested task chain', () => {
    expect(parseTaskExitCode(nested)).toBe(99);
  });

  it('reads a single-level failure', () => {
    expect(
      parseTaskExitCode('task: Failed to run task "playwright:run-local": exit status 1'),
    ).toBe(1);
  });

  it('strips ANSI colour before matching', () => {
    expect(parseTaskExitCode(`\x1b[31m${nested}\x1b[0m`)).toBe(99);
  });

  it('returns null when the output has no task failure line', () => {
    expect(parseTaskExitCode('running (11.8s), 0/5 VUs, 8 complete')).toBeNull();
  });
});

describe('formatExitCode', () => {
  const log = 'task: Failed to run task "k6:run-local": exit status 99';

  it('shows the tool code and the runner code when they differ', () => {
    expect(formatExitCode(TASK_RUNNER_FAILURE_CODE, log)).toBe('99 (task 201)');
  });

  it('leaves any non-201 code alone — it is already the real one', () => {
    expect(formatExitCode(1, log)).toBe('1');
    expect(formatExitCode(0, '')).toBe('0');
  });

  it('keeps a bare 201 when nothing inner can be parsed', () => {
    expect(formatExitCode(TASK_RUNNER_FAILURE_CODE, 'cancelled before task started')).toBe('201');
  });

  it('renders a missing code as N/A', () => {
    expect(formatExitCode(undefined, log)).toBe('N/A');
    expect(formatExitCode(null, log)).toBe('N/A');
  });
});
