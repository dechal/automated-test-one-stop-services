import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  renderReportName,
  reportDirError,
  reportDirKey,
  reportNameError,
  validateReportName,
} from '@hub/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { OUTPUTS_DIR } from '../../config.js';
import { cloneReportFile, discardReportDir, reportDirFor } from '../post-run.js';

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

describe('report clone naming', () => {
  const date = new Date(2026, 10, 7, 3, 4, 5);

  it('renders every date token', () => {
    expect(renderReportName('R_%d-%m-%y_%Y %H.%M.%S', date)).toBe('R_07-11-26_2026 03.04.05');
  });

  it.each([
    ['', 'empty'],
    ['a<b', 'forbiddenChar'],
    ['a/b', 'forbiddenChar'],
    ['ab', 'controlChar'],
    ['CON', 'reserved'],
    ['lpt1.txt', 'reserved'],
    ['name.', 'trailingDotOrSpace'],
    ['name ', 'trailingDotOrSpace'],
    ['x'.repeat(201), 'tooLong'],
    ['SP-NON-LIFE_UAT_11-17-2026', undefined],
  ])('validates %j as %s', (name, expected) => {
    expect(validateReportName(name)).toBe(expected);
  });
});

describe('cloneReportFile', () => {
  it('copies the report next to index.html, keeping the extension and the original', async () => {
    const { root, reportPath } = makeReport();
    cleanup.push(root);
    const target = await cloneReportFile(reportPath, 'UAT_%m-%d-%Y', new Date(2026, 10, 17));
    expect(target).toBe(path.join(path.dirname(reportPath), 'UAT_11-17-2026.html'));
    expect(readFileSync(target as string, 'utf8')).toBe('<html></html>');
    expect(existsSync(reportPath)).toBe(true);
  });

  it('refuses a name Windows forbids', async () => {
    const { root, reportPath } = makeReport();
    cleanup.push(root);
    expect(await cloneReportFile(reportPath, 'bad:name', new Date())).toBeUndefined();
  });
});

describe('report clone formulas', () => {
  const tuesday = new Date(2026, 10, 24, 1, 0, 0);

  it.each([
    ['%m-%d{-1}_%d{+3}-%Y', '11-23_27-2026'],
    ['%d{-24}-%m{-24/24}', '31-10'],
    ['%d{(2+1)*2}', '30'],
    ['%m{+3}-%Y{+0}', '02-2026'],
    ['%y{-1}', '25'],
  ])('renders %s as %s', (template, expected) => {
    expect(renderReportName(template, tuesday)).toBe(expected);
  });

  it('clamps a month shift to the last day of the target month', () => {
    expect(renderReportName('%d-%m{+1}', new Date(2026, 0, 31))).toBe('31-02');
    expect(renderReportName('%d{+0}', new Date(2026, 0, 31))).toBe('31');
  });

  it.each(['%d{}', '%d{-x}', '%d{1/0}', '%d{(1}'])('reports %s as a bad formula', (template) => {
    expect(renderReportName(template, tuesday)).toBeUndefined();
    expect(reportNameError(template, tuesday)).toBe('badFormula');
  });

  it.each([
    [String.raw`C:\Users\me\friday-report\%m-%d`, undefined],
    [String.raw`\\server\share\reports`, undefined],
    ['/home/me/reports/', undefined],
    [String.raw`reports\%m`, 'notAbsolute'],
    [String.raw`C:\Users\me\bad:name`, 'forbiddenChar'],
    [String.raw`C:\Users\CON\x`, 'reserved'],
    [String.raw`C:\Users\me\%d{oops}`, 'badFormula'],
  ])('validates folder %s as %s', (template, expected) => {
    expect(reportDirError(template, tuesday)).toBe(expected);
  });
});

describe('reportDirKey', () => {
  it('treats case, separators and a trailing slash as the same folder', () => {
    expect(reportDirKey(' C:\\Reports\\%m\\ ')).toBe(reportDirKey('c:/reports/%m/'));
    expect(reportDirKey(String.raw`C:\Reports\a`)).not.toBe(reportDirKey(String.raw`C:\Reports\b`));
  });
});

describe('cloneReportFile with a destination folder', () => {
  it('creates the folder and never overwrites an existing copy', async () => {
    const { root, reportPath } = makeReport();
    cleanup.push(root);
    const dest = mkdtempSync(path.join(tmpdir(), 'clone-dest-'));
    cleanup.push(dest);
    const dirTemplate = path.join(dest, '%m-%d{-1}_%d{+3}-%Y');
    const date = new Date(2026, 10, 24);

    const first = await cloneReportFile(reportPath, 'UAT_%m-%d-%Y', date, dirTemplate);
    const second = await cloneReportFile(reportPath, 'UAT_%m-%d-%Y', date, dirTemplate);

    expect(first).toBe(path.join(dest, '11-23_27-2026', 'UAT_11-24-2026.html'));
    expect(second).toBe(path.join(dest, '11-23_27-2026', 'UAT_11-24-2026 (2).html'));
    expect(readFileSync(second as string, 'utf8')).toBe('<html></html>');
  });
});
