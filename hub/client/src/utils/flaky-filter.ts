import type { TestTrendReport } from '@hub/shared';

export interface FlakyFilterResult {
  reports: TestTrendReport[];
  hiddenCount: number;
}

export function filterFlaky(reports: TestTrendReport[], onlyFlaky: boolean): FlakyFilterResult {
  if (!onlyFlaky) return { reports, hiddenCount: 0 };
  let hiddenCount = 0;
  const kept: TestTrendReport[] = [];
  for (const report of reports) {
    const tests = report.tests.filter((test) => test.flakinessScore > 0);
    hiddenCount += report.tests.length - tests.length;
    if (tests.length > 0) kept.push({ ...report, tests });
  }
  return { reports: kept, hiddenCount };
}
