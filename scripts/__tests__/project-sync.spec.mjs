import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { syncProjects } from '../project-sync.mjs';

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

const PROJECT_ID = 'tools/playwright/projects/web/demo';
const BRAIN_ID = 'brain/projects/demo';
const NO_PERSONAL_ID = 'brain/projects/solo';
const NO_MAIN_ID = 'tools/k6';

describe('project-sync', () => {
  /** @type {string} */
  let tmp;
  /** @type {Record<string, { work: string, originBare: string, personalBare: string }>} */
  const repos = {};

  /**
   * @param {string} id
   * @param {{ personal?: boolean, branch?: string }} [options]
   */
  function makeRepo(id, { personal = true, branch = 'main' } = {}) {
    const work = path.join(tmp, ...id.split('/'));
    const originBare = path.join(tmp, 'bare', `${id.replaceAll('/', '_')}-origin.git`);
    const personalBare = path.join(tmp, 'bare', `${id.replaceAll('/', '_')}-personal.git`);
    mkdirSync(work, { recursive: true });
    git(tmp, ['init', '--bare', '-b', 'main', originBare]);
    git(tmp, ['init', '--bare', '-b', 'main', personalBare]);
    git(work, ['init', '-b', branch]);
    git(work, ['remote', 'add', 'origin', originBare]);
    if (personal) git(work, ['remote', 'add', 'personal', personalBare]);
    commit(work, 'a.txt');
    git(work, ['push', 'origin', branch]);
    repos[id] = { work, originBare, personalBare };
  }

  before(() => {
    mkdirSync(CACHE_BASE, { recursive: true });
    tmp = mkdtempSync(path.join(CACHE_BASE, 'project-sync-'));
    mkdirSync(path.join(tmp, 'brain', 'projects', 'no-git'), { recursive: true });
    makeRepo(PROJECT_ID);
    makeRepo(BRAIN_ID);
    makeRepo(NO_PERSONAL_ID, { personal: false });
    makeRepo(NO_MAIN_ID, { branch: 'trunk' });
  });

  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('syncs a test-project repo and a brain repo, skipping repos without personal', async () => {
    const results = await syncProjects({ root: tmp });
    const byRepo = Object.fromEntries(results.map((r) => [r.repo, r.status]));
    assert.equal(byRepo[PROJECT_ID], 'synced');
    assert.equal(byRepo[BRAIN_ID], 'synced');
    assert.equal(NO_PERSONAL_ID in byRepo, false);
    assert.equal(
      git(repos[PROJECT_ID].personalBare, ['rev-parse', 'refs/heads/main']),
      git(repos[PROJECT_ID].originBare, ['rev-parse', 'refs/heads/main']),
    );
  });

  it('reports a repo whose origin has no main as failed with a clear message', async () => {
    const [result] = await syncProjects({ root: tmp, repo: NO_MAIN_ID });
    assert.equal(result?.status, 'failed');
    assert.match(result?.message ?? '', /no main branch/);
  });

  it('reports already-up-to-date on a second run', async () => {
    assert.equal(
      (await syncProjects({ root: tmp, repo: BRAIN_ID }))[0]?.status,
      'already-up-to-date',
    );
  });

  it('reports diverged and leaves personal untouched when personal has its own commit', async () => {
    const { work, personalBare } = repos[PROJECT_ID];
    commit(work, 'b.txt');
    git(work, ['push', 'origin', 'main']);
    git(work, ['checkout', '-b', 'side', 'refs/remotes/personal/main']);
    commit(work, 'personal-only.txt');
    git(work, ['push', 'personal', 'side:main']);
    git(work, ['checkout', 'main']);
    const before = git(personalBare, ['rev-parse', 'refs/heads/main']);
    const [result] = await syncProjects({ root: tmp, repo: PROJECT_ID });
    assert.equal(result?.status, 'diverged');
    assert.equal(git(personalBare, ['rev-parse', 'refs/heads/main']), before);
  });

  it('fails for an unknown repo id and for a repo without personal', async () => {
    assert.equal((await syncProjects({ root: tmp, repo: 'nope' }))[0]?.status, 'failed');
    assert.equal((await syncProjects({ root: tmp, repo: NO_PERSONAL_ID }))[0]?.status, 'failed');
  });
});
