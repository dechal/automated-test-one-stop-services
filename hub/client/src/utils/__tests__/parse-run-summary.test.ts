import { describe, expect, it } from 'vitest';
import { parseRunSummary } from '../parse-run-summary.js';

describe('parseRunSummary', () => {
  it('returns null when there is no recognizable summary', () => {
    expect(parseRunSummary('booting up...\nno results here')).toBeNull();
  });

  it('parses Playwright pass/fail/skip counts', () => {
    expect(parseRunSummary('  3 passed (12.5s)')).toEqual({ passed: 3, failed: 0 });
    expect(parseRunSummary('2 failed\n5 passed\n1 skipped')).toEqual({
      passed: 5,
      failed: 2,
      skipped: 1,
    });
  });

  it('parses Robot Framework summary line', () => {
    expect(parseRunSummary('10 tests, 8 passed, 2 failed')).toEqual({ passed: 8, failed: 2 });
    expect(parseRunSummary('1 test, 1 passed, 0 failed')).toEqual({ passed: 1, failed: 0 });
  });

  it('maps k6 checks_succeeded to a single pass/fail', () => {
    expect(parseRunSummary('checks_succeeded 100.00%')).toEqual({ passed: 1, failed: 0 });
    expect(parseRunSummary('checks_succeeded....... 87.50%')).toEqual({ passed: 0, failed: 1 });
  });

  it('matches a colon-separated k6 leader (both summary formats)', () => {
    // v1.x summary name.
    expect(parseRunSummary('    checks_succeeded...............: 100.00% 46 out of 46')).toEqual({
      passed: 1,
      failed: 0,
    });
    // Legacy summary name, taken verbatim from a real run log.
    expect(
      parseRunSummary('     checks.........................: 34.59% ✓ 67216      ✗ 127105'),
    ).toEqual({ passed: 0, failed: 1 });
    expect(parseRunSummary('     checks.........................: 100.00% ✓ 46       ✗ 0')).toEqual(
      { passed: 1, failed: 0 },
    );
  });

  it('counts a threshold breach as a failure even when every check succeeded', () => {
    const log = [
      '     checks.........................: 100.00% ✓ 46       ✗ 0',
      'level=error msg="thresholds on metrics \'http_req_duration\' have been crossed"',
    ].join('\n');
    expect(parseRunSummary(log)).toEqual({ passed: 0, failed: 1 });
  });

  it('ignores the k6 checks_failed line so it cannot be read as the checks total', () => {
    expect(parseRunSummary('    checks_failed..................: 0.00%   0 out of 46')).toBeNull();
  });

  it('strips ANSI colour codes before matching', () => {
    expect(parseRunSummary('\x1b[32m4 passed\x1b[0m (3.1s)')).toEqual({ passed: 4, failed: 0 });
  });
});
