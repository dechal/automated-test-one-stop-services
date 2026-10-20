import type { ReportEntry } from '@hub/shared';
import { describe, expect, it } from 'vitest';
import { isCrashReport, isHubOrigin } from '../report-origin';

describe('isHubOrigin', () => {
  it('treats a report carrying only runMode as Hub-origin', () => {
    expect(isHubOrigin({ runMode: 'local' })).toBe(true);
  });

  it('treats a bare local report with no run metadata as not Hub-origin', () => {
    expect(isHubOrigin({})).toBe(false);
  });
});

describe('isCrashReport', () => {
  const crash = (
    status: ReportEntry['status'],
    summary?: ReportEntry['summary'],
  ): Pick<ReportEntry, 'status' | 'summary'> => ({ status, summary });

  it('is not a crash when the error run has counted failures', () => {
    expect(isCrashReport(crash('error', { passed: 10, failed: 3 }))).toBe(false);
  });

  it('is a crash when the run errored with no counts at all', () => {
    expect(isCrashReport(crash('error'))).toBe(true);
  });
});
