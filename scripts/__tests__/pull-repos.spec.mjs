import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { planPulls, pullAll } from '../lib/pull-repos.mjs';

describe('pull-repos', () => {
  /** @type {string} */
  let root;

  before(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'pull-repos-'));
    for (const rel of [
      'tools/alpha/.git',
      'tools/alpha/projects/web/one/.git',
      'tools/beta/node_modules/x/.git',
    ]) {
      mkdirSync(path.join(root, rel), { recursive: true });
    }
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('lists the root first, then every nested repo under tools/ with a tools-relative name', () => {
    const targets = planPulls(root);
    assert.deepEqual(
      targets.map((t) => t.name),
      ['root', 'alpha', 'alpha/projects/web/one'],
    );
    assert.equal(targets[1]?.dir, path.join(root, 'tools', 'alpha'));
  });

  it('keeps going after a failure and reports the failed names', () => {
    const lines = /** @type {string[]} */ ([]);
    const failed = pullAll(
      planPulls(root),
      (dir) => !dir.endsWith('alpha'),
      (line) => lines.push(line),
    );
    assert.deepEqual(failed, ['alpha']);
    assert.ok(lines.includes('  [alpha] failed'));
    assert.ok(lines.includes('  [alpha/projects/web/one] done'));
  });
});
