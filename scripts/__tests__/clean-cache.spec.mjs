import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { selectStaleTargets } from '../clean-cache.mjs';

const ROOT = path.resolve('fixture-cache');
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-01T00:00:00Z');
/** @type {Record<string, number>} */
const AGE_DAYS = { old: 8, fresh: 1, edge: 7 };

/** @param {string} dir @returns {string[]} */
const list = (dir) => (dir === path.join(ROOT, 'deletable') ? Object.keys(AGE_DAYS) : []);
/** @param {string} target @returns {number} */
const mtime = (target) => NOW - (AGE_DAYS[path.basename(target)] ?? 0) * DAY;

describe('selectStaleTargets', () => {
  it('selects only deletable/ entries older than the cutoff', () => {
    assert.deepEqual(selectStaleTargets(ROOT, list, mtime, 7, NOW), [
      path.join(ROOT, 'deletable', 'old'),
    ]);
  });

  it('keeps everything when nothing is old enough', () => {
    assert.deepEqual(selectStaleTargets(ROOT, list, mtime, 30, NOW), []);
  });

  it('never selects an entry whose age could not be read', () => {
    assert.deepEqual(
      selectStaleTargets(ROOT, list, () => Number.POSITIVE_INFINITY, 1, NOW),
      [],
    );
  });
});
