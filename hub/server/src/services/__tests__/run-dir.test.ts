import { runDirFromReportPath } from '@hub/shared';
import { describe, expect, it } from 'vitest';

const RUN = 'outputs/playwright/web/shop/success/2026-09-09/07-05-03';

describe('runDirFromReportPath — one rule for every tool layout', () => {
  it('handles Playwright, whose report sits in html-results/', () => {
    expect(runDirFromReportPath(`${RUN}/html-results/index.html`)).toBe(RUN);
  });

  it('handles Robot, whose report sits directly in the run directory', () => {
    const run = 'outputs/robot-framework/web/shop/success/2026-09-09/07-05-03';
    expect(runDirFromReportPath(`${run}/report.html`)).toBe(run);
  });

  it('handles k6, which nests a round folder and has no type segment', () => {
    const run = 'outputs/k6/load-app/checkout/success/2026-09-09/07-05-03';
    expect(runDirFromReportPath(`${run}/round_1/report_x.html`)).toBe(run);
  });

  it('normalises Windows separators', () => {
    expect(runDirFromReportPath(RUN.replace(/\//g, '\\') + '\\html-results\\index.html')).toBe(RUN);
  });

  it('falls back to two levels up when the path carries no date segment', () => {
    expect(runDirFromReportPath('outputs/tool/project/html-results/index.html')).toBe(
      'outputs/tool/project',
    );
  });
});
