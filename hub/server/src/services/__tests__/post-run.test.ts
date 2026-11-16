import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OUTPUTS_DIR } from '../../config.js';
import { discardReportDir, reportDirFor } from '../post-run.js';

/** A throwaway report tree inside the real OUTPUTS_DIR, shaped like a run's. */
function makeReport(): { root: string; reportPath: string } {
  mkdirSync(OUTPUTS_DIR, { recursive: true });
  const root = mkdtempSync(path.join(OUTPUTS_DIR, 'post-run-test-'));
  const timeDir = path.join(root, '2026-08-05', '09-30-00');
  const htmlDir = path.join(timeDir, 'html-results');
  mkdirSync(htmlDir, { recursive: true });
  writeFileSync(path.join(htmlDir, 'index.html'), '<html></html>', 'utf8');
  writeFileSync(path.join(timeDir, 'results.json'), '{"suites":[]}', 'utf8');
  return { root, reportPath: path.join(htmlDir, 'index.html') };
}

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('reportDirFor', () => {
  it('resolves the run time dir from its html-results/index.html', () => {
    const reportPath = path.join(
      'outputs',
      'playwright',
      'web',
      'p',
      'success',
      'd',
      't',
      'html-results',
      'index.html',
    );
    expect(reportDirFor(reportPath)).toBe(
      path.join('outputs', 'playwright', 'web', 'p', 'success', 'd', 't'),
    );
  });
});

describe('discardReportDir', () => {
  it("removes the run's whole report dir, leaving the rest of outputs/ alone", async () => {
    const { root, reportPath } = makeReport();
    cleanup.push(root);
    const timeDir = reportDirFor(reportPath);
    expect(existsSync(timeDir)).toBe(true);

    expect(await discardReportDir(reportPath)).toBe(true);
    expect(existsSync(timeDir)).toBe(false);
    // Only the one run is dropped — its date dir (a sibling of other runs) stays.
    expect(existsSync(path.dirname(timeDir))).toBe(true);
    expect(existsSync(OUTPUTS_DIR)).toBe(true);
  });

  it('refuses a path outside outputs/ instead of deleting it', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'not-outputs-'));
    cleanup.push(outside);
    const htmlDir = path.join(outside, 'html-results');
    mkdirSync(htmlDir, { recursive: true });
    writeFileSync(path.join(htmlDir, 'index.html'), 'x', 'utf8');

    expect(await discardReportDir(path.join(htmlDir, 'index.html'))).toBe(false);
    expect(existsSync(outside)).toBe(true);
  });

  it('reports success when the dir is already gone (a repeat purge is harmless)', async () => {
    const { root, reportPath } = makeReport();
    cleanup.push(root);
    expect(await discardReportDir(reportPath)).toBe(true);
    expect(await discardReportDir(reportPath)).toBe(true);
  });
});
