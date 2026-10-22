import type { TestTrend, TestTrendReport } from '@hub/shared';
import { describe, expect, it } from 'vitest';
import { filterFlaky } from '~/utils/flaky-filter.js';

function trend(key: string, flakinessScore: number): TestTrend {
  return {
    key,
    title: key,
    totalRuns: 4,
    passes: 2,
    failures: 2,
    passRate: 50,
    flips: flakinessScore > 0 ? 2 : 0,
    flakinessScore,
    isFlaky: flakinessScore > 0,
    points: [],
    lastStatus: 'passed',
    lastSeen: '2026-07-27T10:00:00.000Z',
  };
}

function report(project: string, scores: number[]): TestTrendReport {
  const tests = scores.map((s, i) => trend(`${project}-${i}`, s));
  return {
    generatedAt: '2026-07-27T10:00:00.000Z',
    tool: 'playwright',
    type: 'web',
    project,
    runsAnalyzed: 4,
    totalTests: tests.length,
    flakyCount: tests.filter((t) => t.isFlaky).length,
    tests,
    unavailable: false,
  };
}

describe('filterFlaky', () => {
  it('drops a group whose tests are all stable', () => {
    const { reports } = filterFlaky([report('stable', [0, 0]), report('mixed', [0, 40])], true);
    expect(reports.map((r) => r.project)).toEqual(['mixed']);
  });

  it('keeps only the flaky rows of a mixed group', () => {
    const { reports } = filterFlaky([report('mixed', [0, 40, 0, 10])], true);
    expect(reports[0]?.tests.map((t) => t.flakinessScore)).toEqual([40, 10]);
  });

  it('returns the input unchanged when the filter is off', () => {
    const input = [report('stable', [0, 0]), report('mixed', [0, 40])];
    const result = filterFlaky(input, false);
    expect(result.reports).toBe(input);
    expect(result.hiddenCount).toBe(0);
  });

  it('counts every removed row as hidden', () => {
    const { hiddenCount } = filterFlaky(
      [report('stable', [0, 0]), report('mixed', [0, 40, 0])],
      true,
    );
    expect(hiddenCount).toBe(4);
  });
});
