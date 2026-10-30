import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { findNestedCacheDirs, selectStaleTargets } from '../clean-cache.mjs';

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

describe('findNestedCacheDirs', () => {
  const WS = path.resolve('fixture-ws');
  /** @type {Record<string, string[]>} */
  const TREE = {
    [WS]: ['.cache', 'hub', 'tools', 'outputs', 'node_modules'],
    [path.join(WS, 'hub')]: ['.cache', 'server'],
    [path.join(WS, 'hub', 'server')]: [],
    [path.join(WS, 'tools')]: ['alpha'],
    [path.join(WS, 'tools', 'alpha')]: ['projects'],
    [path.join(WS, 'tools', 'alpha', 'projects')]: ['.cache'],
    [path.join(WS, 'outputs')]: ['.cache'],
    [path.join(WS, 'node_modules')]: ['.cache'],
  };
  /** @param {string} dir */
  const listDirs = (dir) => (TREE[dir] ?? []).map((name) => ({ name, isDirectory: true }));

  it('finds every .cache below the workspace except the root one, outputs and node_modules', () => {
    assert.deepEqual(findNestedCacheDirs(WS, listDirs), [
      path.join(WS, 'hub', '.cache'),
      path.join(WS, 'tools', 'alpha', 'projects', '.cache'),
    ]);
  });
});
