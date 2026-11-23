import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const paths = await vi.hoisted(async () => {
  const nodePath = await import('node:path');
  const nodeUrl = await import('node:url');
  const repoRoot = nodePath.resolve(
    nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    '..',
  );
  const suffix = Math.random().toString(36).slice(2, 10);
  return {
    scriptsDir: nodePath.join(repoRoot, 'scripts'),
    tempRoot: nodePath.join(repoRoot, '.cache', 'deletable', `remotes-test-${suffix}`),
  };
});

vi.mock('../../config.js', () => ({
  WORKSPACE_ROOT: paths.tempRoot,
  SCRIPTS_DIR: paths.scriptsDir,
}));

const SECRET_URL = 'https://user:tok@example.com/r.git';
const REPO_IDS = {
  tool: 'tools/k6',
  brain: 'brain/projects/b1',
  project: 'tools/playwright/projects/web/p1',
};

function git(cwd: string, args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

function repoDir(id: string): string {
  return path.join(paths.tempRoot, ...id.split('/'));
}

function remoteUrl(id: string, name: string): string | null {
  const res = spawnSync('git', ['remote', 'get-url', name], {
    cwd: repoDir(id),
    encoding: 'utf8',
  });
  return res.status === 0 ? res.stdout.trim() : null;
}

describe('/api/remotes', () => {
  let app: ReturnType<typeof Fastify>;
  const bare = (n: string): string => path.join(paths.tempRoot, 'bare', `${n}.git`);
  const bareUrl = (n: string): string => pathToFileURL(bare(n)).href;

  beforeAll(async () => {
    mkdirSync(path.join(paths.tempRoot, 'bare'), { recursive: true });
    for (const n of ['a', 'b', 'c', 'd']) {
      git(paths.tempRoot, ['init', '--bare', '-b', 'main', bare(n)]);
    }
    for (const id of Object.values(REPO_IDS)) {
      mkdirSync(repoDir(id), { recursive: true });
      git(repoDir(id), ['init', '-b', 'main']);
      git(repoDir(id), ['remote', 'add', 'origin', bare('a')]);
    }
    git(repoDir(REPO_IDS.tool), ['remote', 'set-url', 'origin', SECRET_URL]);
    git(repoDir(REPO_IDS.brain), ['remote', 'add', 'personal', bare('b')]);
    git(repoDir(REPO_IDS.brain), ['remote', 'add', 'spare', bare('c')]);
    const { remotesRoutes } = await import('../remotes.js');
    app = Fastify();
    await app.register(remotesRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(paths.tempRoot, { recursive: true, force: true });
  });

  async function post(action: string, payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: `/api/remotes/${action}`, payload });
  }

  it('lists repos with masked URLs and no dir', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/remotes' });
    expect(res.statusCode).toBe(200);
    const { repos } = res.json() as {
      repos: { id: string; remotes: { name: string; url: string }[] }[];
    };
    expect(repos.map((r) => r.id).sort()).toEqual(Object.values(REPO_IDS).sort());
    const tool = repos.find((r) => r.id === REPO_IDS.tool);
    expect(tool?.remotes).toEqual([{ name: 'origin', url: 'https://***@example.com/r.git' }]);
    expect(res.body).not.toContain('tok');
    expect(res.body).not.toContain('"dir"');
  });

  it('set-url to a reachable local bare repo updates the config', async () => {
    const res = await post('set-url', {
      repo: REPO_IDS.project,
      name: 'origin',
      url: bareUrl('d'),
    });
    expect(res.statusCode).toBe(200);
    expect(remoteUrl(REPO_IDS.project, 'origin')).toBe(bareUrl('d'));
  });

  it('set-url to a nonexistent path is rejected and config stays', async () => {
    const before = remoteUrl(REPO_IDS.project, 'origin');
    const missing = pathToFileURL(path.join(paths.tempRoot, 'bare', 'missing.git')).href;
    const res = await post('set-url', { repo: REPO_IDS.project, name: 'origin', url: missing });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('REMOTE_UNREACHABLE');
    expect(remoteUrl(REPO_IDS.project, 'origin')).toBe(before);
  });

  it('add creates a remote that then appears in the list', async () => {
    const res = await post('add', { repo: REPO_IDS.tool, name: 'mirror', url: bareUrl('b') });
    expect(res.statusCode).toBe(200);
    expect(remoteUrl(REPO_IDS.tool, 'mirror')).toBe(bareUrl('b'));
    const list = await app.inject({ method: 'GET', url: '/api/remotes' });
    expect(list.body).toContain('mirror');
  });

  it('add with an existing name returns 409', async () => {
    const res = await post('add', { repo: REPO_IDS.tool, name: 'mirror', url: bareUrl('c') });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('REMOTE_EXISTS');
  });

  it('delete with a wrong confirmation URL returns 400 and keeps the remote', async () => {
    const res = await post('delete', {
      repo: REPO_IDS.brain,
      name: 'spare',
      confirmUrl: bareUrl('d'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('URL_MISMATCH');
    expect(remoteUrl(REPO_IDS.brain, 'spare')).not.toBeNull();
  });

  it('delete with the exact URL removes a non-origin remote', async () => {
    const res = await post('delete', {
      repo: REPO_IDS.brain,
      name: 'spare',
      confirmUrl: ` ${remoteUrl(REPO_IDS.brain, 'spare')} `,
    });
    expect(res.statusCode).toBe(200);
    expect(remoteUrl(REPO_IDS.brain, 'spare')).toBeNull();
  });

  it('delete origin is forbidden even with the correct URL', async () => {
    const res = await post('delete', {
      repo: REPO_IDS.brain,
      name: 'origin',
      confirmUrl: remoteUrl(REPO_IDS.brain, 'origin'),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ORIGIN_PROTECTED');
    expect(remoteUrl(REPO_IDS.brain, 'origin')).not.toBeNull();
  });

  it.each(['-x', 'a b', '..'])('rejects invalid remote name %j', async (name) => {
    const res = await post('add', { repo: REPO_IDS.tool, name, url: bareUrl('c') });
    expect(res.statusCode).toBe(400);
  });

  it.each([
    '-oProxyCommand=x',
    'ext::sh -c x',
    'http://example.com/r.git',
    'https://u:t@example.com/r.git',
  ])('rejects invalid remote URL %j', async (url) => {
    const res = await post('add', { repo: REPO_IDS.tool, name: 'bad', url });
    expect(res.statusCode).toBe(400);
    expect(remoteUrl(REPO_IDS.tool, 'bad')).toBeNull();
  });

  it.each(['no/such/repo', '../x'])('unknown repo id %j returns 404', async (repo) => {
    const res = await post('add', { repo, name: 'extra', url: bareUrl('c') });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('REPO_NOT_FOUND');
  });
});
