#!/usr/bin/env node
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listRepos, readRemotes } from './remotes.mjs';

const SOURCE_REMOTE = 'origin';
const TARGET_REMOTE = 'personal';
const BRANCH = 'main';
const GIT_TIMEOUT_MS = 120_000;

/**
 * @typedef {'synced' | 'already-up-to-date' | 'diverged' | 'failed'} SyncStatus
 * @typedef {{ repo: string, status: SyncStatus, message: string }} SyncResult
 * @typedef {{ ok: boolean, stdout: string, stderr: string }} GitRun
 * @typedef {{ id: string, dir: string }} SyncTarget
 * @typedef {(cwd: string, args: string[]) => GitRun | Promise<GitRun>} GitRunner
 */

/** @returns {string} */
export function workspaceRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** @param {string} cwd @param {string[]} args @returns {Promise<GitRun>} */
function runGit(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) =>
        resolve({
          ok: !error,
          stdout: (stdout ?? '').trim(),
          stderr: (stderr || error?.message || '').trim(),
        }),
    );
  });
}

/** @param {string} root @returns {Promise<SyncTarget[]>} */
export async function listTargets(root) {
  const repos = listRepos(root);
  const infos = await Promise.all(repos.map(({ dir }) => readRemotes(dir)));
  return repos
    .filter((_, i) => infos[i]?.remotes.some((r) => r.name === TARGET_REMOTE))
    .map(({ id, dir }) => ({ id, dir }));
}
/**
 * @param {string} id
 * @param {string} dir
 * @param {GitRunner} git
 * @returns {Promise<SyncResult>}
 */
async function syncOne(id, dir, git) {
  /** @param {SyncStatus} status @param {string} message @returns {SyncResult} */
  const result = (status, message) => ({ repo: id, status, message });
  const sourceRef = `refs/remotes/${SOURCE_REMOTE}/${BRANCH}`;
  const targetRef = `refs/remotes/${TARGET_REMOTE}/${BRANCH}`;

  const [fetchSource, fetchTarget] = await Promise.all([
    git(dir, ['fetch', SOURCE_REMOTE]),
    git(dir, ['fetch', TARGET_REMOTE]),
  ]);
  if (!fetchSource.ok) return result('failed', `fetch ${SOURCE_REMOTE}: ${fetchSource.stderr}`);
  if (!fetchTarget.ok) return result('failed', `fetch ${TARGET_REMOTE}: ${fetchTarget.stderr}`);

  const source = await git(dir, ['rev-parse', '--verify', sourceRef]);
  if (!source.ok)
    return result(
      'failed',
      `${SOURCE_REMOTE} has no ${BRANCH} branch; its default branch may differ, nothing pushed`,
    );
  const target = await git(dir, ['rev-parse', '--verify', '--quiet', targetRef]);

  if (target.ok) {
    if (target.stdout === source.stdout) {
      return result(
        'already-up-to-date',
        `${TARGET_REMOTE}/${BRANCH} at ${source.stdout.slice(0, 7)}`,
      );
    }
    const behind = await git(dir, ['merge-base', '--is-ancestor', target.stdout, source.stdout]);
    if (!behind.ok) {
      return result(
        'diverged',
        `${TARGET_REMOTE}/${BRANCH} has commits ${SOURCE_REMOTE}/${BRANCH} lacks; skipped`,
      );
    }
  }

  const push = await git(dir, ['push', TARGET_REMOTE, `${sourceRef}:refs/heads/${BRANCH}`]);
  if (!push.ok) return result('failed', `push ${TARGET_REMOTE}: ${push.stderr}`);
  return result('synced', `${TARGET_REMOTE}/${BRANCH} -> ${source.stdout.slice(0, 7)}`);
}

/**
 * @param {{ root?: string, repo?: string, git?: GitRunner }} [options]
 * @returns {Promise<SyncResult[]>}
 */
export async function syncProjects({ root = workspaceRoot(), repo, git = runGit } = {}) {
  const targets = await listTargets(root);
  const selected = repo ? targets.filter((t) => t.id === repo) : targets;
  if (repo && selected.length === 0) {
    return [
      {
        repo,
        status: 'failed',
        message: `no repo "${repo}" with a ${TARGET_REMOTE} remote`,
      },
    ];
  }
  return Promise.all(selected.map(({ id, dir }) => syncOne(id, dir, git)));
}

/** @param {SyncResult[]} results @returns {string} */
export function formatResults(results) {
  if (results.length === 0) return `no repo has a ${TARGET_REMOTE} remote`;
  return results.map((r) => `  [${r.repo}] ${r.status}: ${r.message}`).join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const repo = args.find((a) => !a.startsWith('--'));
  const results = await syncProjects({ repo });
  console.log(asJson ? JSON.stringify(results, null, 2) : formatResults(results));
  const bad = results.some((r) => r.status === 'failed' || r.status === 'diverged');
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
