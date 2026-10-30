import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  applyRetention,
  DEFAULT_RETENTION_DAYS,
  parseArgs,
  parseRetentionDays,
  planRetention,
  runStartedAt,
} from '../lib/outputs-retention.mjs';

const NOW = new Date(2026, 9, 28, 12, 0, 0).getTime();

/** @param {string} root @param {string} rel */
const dir = (root, rel) => mkdirSync(path.join(root, rel), { recursive: true });
/** @param {string} root @param {string} rel */
const file = (root, rel) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), 'x');
};

describe('runStartedAt', () => {
  it('reads local time from the date and time segments', () => {
    assert.equal(
      runStartedAt('2026-09-10', '15-15-49'),
      new Date(2026, 8, 10, 15, 15, 49).getTime(),
    );
    assert.equal(
      runStartedAt('2026-08-11', '15-38-14.zip'),
      new Date(2026, 7, 11, 15, 38, 14).getTime(),
    );
  });

  it('rejects names that are not a real date or time', () => {
    assert.equal(runStartedAt('2026-02-30', '10-00-00'), undefined);
    assert.equal(runStartedAt('2026-09-10', '25-00-00'), undefined);
    assert.equal(runStartedAt('10-28-2026', '10-00-00'), undefined);
    assert.equal(runStartedAt('2026-09-10', 'html-results'), undefined);
  });
});

describe('parseRetentionDays', () => {
  it('defaults when unset or blank and rejects junk', () => {
    assert.equal(parseRetentionDays(undefined), DEFAULT_RETENTION_DAYS);
    assert.equal(parseRetentionDays(''), DEFAULT_RETENTION_DAYS);
    assert.equal(parseRetentionDays('7'), 7);
    assert.throws(() => parseRetentionDays('0'));
    assert.throws(() => parseRetentionDays('abc'));
  });

  it('lets --days win over the env var', () => {
    assert.equal(parseArgs(['--days=3'], { OUTPUTS_RETENTION_DAYS: '9' }).days, 3);
    assert.equal(parseArgs([], { OUTPUTS_RETENTION_DAYS: '9' }).days, 9);
    assert.equal(parseArgs(['--dry-run'], {}).dryRun, true);
  });
});

describe('applyRetention', () => {
  /** @type {string} */
  let root;

  before(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'outputs-retention-'));
    file(root, 'pw/web/a/error/2026-08-01/10-00-00/results.json');
    file(root, 'pw/web/a/error/2026-08-01/11-00-00/.lock');
    file(root, 'pw/web/a/error/2026-08-02/09-00-00/.favorite');
    file(root, 'pw/web/a/error/2026-08-03/15-38-14.zip');
    file(root, 'pw/web/a/success/2026-10-27/10-00-00/results.json');
    dir(root, 'pw/web/b/success/2026-07-01');
    dir(root, 'pw/web/b/success/2026-10-27');
    file(root, 'others/08-01-2026/report/index.md');
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('plans by path date, keeps marked runs and lists old empty date folders', () => {
    const plan = planRetention({ outputsDir: root, days: 30, now: NOW });
    const rel = (/** @type {string} */ p) => path.relative(root, p).split(path.sep).join('/');
    assert.deepEqual(plan.expired.map((r) => rel(r.path)).sort(), [
      'pw/web/a/error/2026-08-01/10-00-00',
      'pw/web/a/error/2026-08-03/15-38-14.zip',
    ]);
    assert.deepEqual(plan.kept.map((r) => rel(r.path)).sort(), [
      'pw/web/a/error/2026-08-01/11-00-00',
      'pw/web/a/error/2026-08-02/09-00-00',
    ]);
    assert.deepEqual(plan.emptyDateDirs.map(rel), ['pw/web/b/success/2026-07-01']);
  });

  it('deletes nothing on --dry-run', () => {
    const result = applyRetention({ outputsDir: root, days: 30, now: NOW, dryRun: true });
    assert.equal(result.removed.length, 0);
    assert.ok(existsSync(path.join(root, 'pw/web/a/error/2026-08-01/10-00-00')));
  });

  it('removes expired runs and prunes the parents they leave empty', () => {
    const result = applyRetention({ outputsDir: root, days: 30, now: NOW });
    assert.equal(result.removed.length, 2);
    assert.equal(result.failed.length, 0);
    assert.ok(!existsSync(path.join(root, 'pw/web/a/error/2026-08-03')));
    assert.ok(!existsSync(path.join(root, 'pw/web/b/success/2026-07-01')));
    assert.ok(existsSync(path.join(root, 'pw/web/a/error/2026-08-01/11-00-00/.lock')));
    assert.ok(existsSync(path.join(root, 'pw/web/a/error/2026-08-02/09-00-00/.favorite')));
    assert.ok(existsSync(path.join(root, 'pw/web/a/success/2026-10-27/10-00-00/results.json')));
    assert.ok(existsSync(path.join(root, 'pw/web/b/success/2026-10-27')));
    assert.ok(existsSync(path.join(root, 'others/08-01-2026/report/index.md')));
    assert.ok(existsSync(root));
  });
});
