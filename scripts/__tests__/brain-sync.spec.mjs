import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { syncBrain } from '../brain-sync.mjs';

const CACHE_BASE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.cache',
  'deletable',
);

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

/**
 * @param {string} dir
 * @param {string} file
 */
function commit(dir, file) {
  writeFileSync(path.join(dir, file), file);
  git(dir, ['add', file]);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-m', file]);
}

describe('brain-sync', () => {
  /** @type {string} */
  let tmp;
  /** @type {string} */
  let work;
  /** @type {string} */
  let originBare;
  /** @type {string} */
  let personalBare;

  before(() => {
    mkdirSync(CACHE_BASE, { recursive: true });
    tmp = mkdtempSync(path.join(CACHE_BASE, 'brain-sync-'));
    originBare = path.join(tmp, 'origin.git');
    personalBare = path.join(tmp, 'personal.git');
    work = path.join(tmp, 'brain', 'projects', 'demo');
    mkdirSync(path.join(tmp, 'brain', 'projects', 'no-git'), { recursive: true });
    mkdirSync(work, { recursive: true });
    git(tmp, ['init', '--bare', '-b', 'main', originBare]);
    git(tmp, ['init', '--bare', '-b', 'main', personalBare]);
    git(work, ['init', '-b', 'main']);
    git(work, ['remote', 'add', 'origin', originBare]);
    git(work, ['remote', 'add', 'personal', personalBare]);
    commit(work, 'a.txt');
    git(work, ['push', 'origin', 'main']);
  });

  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('skips folders without their own .git and syncs a behind personal remote', async () => {
    const results = await syncBrain({ root: tmp });
    assert.deepEqual(
      results.map((r) => [r.project, r.status]),
      [['demo', 'synced']],
    );
    assert.equal(
      git(personalBare, ['rev-parse', 'refs/heads/main']),
      git(originBare, ['rev-parse', 'refs/heads/main']),
    );
  });

  it('reports already-up-to-date on a second run', async () => {
    assert.equal(
      (await syncBrain({ root: tmp, project: 'demo' }))[0]?.status,
      'already-up-to-date',
    );
  });

  it('reports diverged and leaves personal untouched when personal has its own commit', async () => {
    commit(work, 'b.txt');
    git(work, ['push', 'origin', 'main']);
    git(work, ['checkout', '-b', 'side', 'refs/remotes/personal/main']);
    commit(work, 'personal-only.txt');
    git(work, ['push', 'personal', 'side:main']);
    git(work, ['checkout', 'main']);
    const before = git(personalBare, ['rev-parse', 'refs/heads/main']);
    const [result] = await syncBrain({ root: tmp, project: 'demo' });
    assert.equal(result?.status, 'diverged');
    assert.equal(git(personalBare, ['rev-parse', 'refs/heads/main']), before);
  });

  it('fails for an unknown project slug', async () => {
    assert.equal((await syncBrain({ root: tmp, project: 'nope' }))[0]?.status, 'failed');
  });
});
