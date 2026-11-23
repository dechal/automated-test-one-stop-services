import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listRepos, maskUrl } from '../remotes.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'remotes.mjs');
const CACHE_BASE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.cache',
  'deletable',
);
const SECRET_URL = 'https://user:tok@example.com/r.git';
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
describe('remotes', () => {
  /** @type {string} */
  let tmp;
  before(() => {
    mkdirSync(CACHE_BASE, { recursive: true });
    tmp = mkdtempSync(path.join(CACHE_BASE, 'remotes-'));
    const repos = [
      path.join(tmp, 'tools', 'x'),
      path.join(tmp, 'tools', 'x', 'projects', 'web', 'p1'),
      path.join(tmp, 'brain', 'projects', 'b1'),
    ];
    for (const dir of repos) {
      mkdirSync(dir, { recursive: true });
      git(dir, ['init', '-b', 'main']);
    }
    git(repos[0] ?? tmp, ['remote', 'add', 'origin', SECRET_URL]);
    git(repos[1] ?? tmp, ['remote', 'add', 'origin', 'git@example.com:team/p1.git']);
    git(repos[1] ?? tmp, ['remote', 'add', 'personal', 'https://example.com/me/p1.git']);
    mkdirSync(path.join(tmp, 'tools', 'plain'), { recursive: true });
    mkdirSync(path.join(tmp, 'brain', 'projects', 'no-git'), { recursive: true });
  });
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  it('masks userinfo in https and ssh URLs only', () => {
    assert.equal(maskUrl(SECRET_URL), 'https://***@example.com/r.git');
    assert.equal(maskUrl('ssh://git@example.com/r.git'), 'ssh://***@example.com/r.git');
    assert.equal(maskUrl('git@example.com:r.git'), 'git@example.com:r.git');
  });
  it('discovers repos with their own .git and skips plain folders', () => {
    const ids = listRepos(tmp).map((r) => r.id);
    assert.deepEqual(ids, ['tools/x', 'tools/x/projects/web/p1', 'brain/projects/b1']);
  });
  it('--json lists masked remotes for the given --root', () => {
    const res = spawnSync(process.execPath, [SCRIPT, '--json', '--root', tmp], {
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    const tool = out.find((/** @type {{ id: string }} */ r) => r.id === 'tools/x');
    assert.deepEqual(tool.remotes, [{ name: 'origin', url: 'https://***@example.com/r.git' }]);
    const project = out.find(
      (/** @type {{ id: string }} */ r) => r.id === 'tools/x/projects/web/p1',
    );
    assert.equal(project.kind, 'project');
    assert.deepEqual(
      project.remotes.map((/** @type {{ name: string }} */ m) => m.name),
      ['origin', 'personal'],
    );
    assert.equal(res.stdout.includes('tok'), false);
  });
  it('human output prints one line per remote', () => {
    const res = spawnSync(process.execPath, [SCRIPT, '--root', tmp], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const lines = res.stdout.trim().split('\n');
    assert.equal(lines.length, 4);
    assert.equal(res.stdout.includes('tok'), false);
  });
});
