import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.HUB_DB_PATH = ':memory:';
});

const { OUTPUTS_DIR } = await import('../../config.js');
const { discardReportDir } = await import('../post-run.js');

const FIXTURE_ROOT = path.join(OUTPUTS_DIR, '__discard-guard-test__');

function makeReportDir(relative: string): string {
  const dir = path.join(FIXTURE_ROOT, relative);
  fs.mkdirSync(path.join(dir, 'html-results'), { recursive: true });
  const file = path.join(dir, 'html-results', 'index.html');
  fs.writeFileSync(file, '<html></html>', 'utf8');
  return file;
}

const runDirOf = (reportFile: string): string => path.dirname(path.dirname(reportFile));

describe('discardReportDir — a discard may only delete the run own directory', () => {
  beforeEach(() => {
    fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
    fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it('deletes the directory whose stamp matches the run', async () => {
    const report = makeReportDir('web/shop/success/2026-09-09/07-05-03');
    expect(await discardReportDir(report, '2026-09-09/07-05-03')).toBe(true);
    expect(fs.existsSync(runDirOf(report))).toBe(false);
  });

  it('refuses when the directory belongs to a DIFFERENT run of the same project', async () => {
    const mine = makeReportDir('web/shop/success/2026-09-09/07-05-03');
    const theirs = makeReportDir('web/shop/success/2026-09-09/07-05-40');

    expect(await discardReportDir(theirs, '2026-09-09/07-05-03')).toBe(false);
    expect(fs.existsSync(runDirOf(theirs))).toBe(true);
    expect(fs.existsSync(runDirOf(mine))).toBe(true);
  });

  it('still deletes for a legacy run that carries no stamp', async () => {
    const report = makeReportDir('web/shop/success/2026-09-09/07-05-03');
    expect(await discardReportDir(report, undefined)).toBe(true);
    expect(fs.existsSync(runDirOf(report))).toBe(false);
  });

  it('never escapes outputs/', async () => {
    const outside = path.join(os.tmpdir(), 'not-outputs', 'html-results', 'index.html');
    expect(await discardReportDir(outside)).toBe(false);
  });
});
