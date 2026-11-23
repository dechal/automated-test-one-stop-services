#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE_REMOTE = 'origin';
const TARGET_REMOTE = 'personal';
const BRANCH = 'main';
const GIT_TIMEOUT_MS = 120_000;
const BRAIN_PROJECTS_DIR = ['brain', 'projects'];

/**
 * @typedef {'synced' | 'already-up-to-date' | 'diverged' | 'failed'} SyncStatus
 * @typedef {{ project: string, status: SyncStatus, message: string }} SyncResult
 * @typedef {{ ok: boolean, stdout: string, stderr: string }} GitRun
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

/**
 * @param {string} root
 * @param {GitRunner} git
 * @returns {Promise<{ slug: string, dir: string }[]>}
 */
export async function listTargets(root, git = runGit) {
  const base = path.join(root, ...BRAIN_PROJECTS_DIR);
  if (!existsSync(base)) return [];
  const repos = readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(base, e.name, '.git')))
    .map((e) => ({ slug: e.name, dir: path.join(base, e.name) }));
  const remotes = await Promise.all(repos.map(({ dir }) => git(dir, ['remote'])));
  return repos.filter((_, i) => remotes[i]?.stdout.split(/\s+/).includes(TARGET_REMOTE));
}

/**
 * @param {string} slug
 * @param {string} dir
 * @param {GitRunner} git
 * @returns {Promise<SyncResult>}
 */
async function syncOne(slug, dir, git) {
  /** @param {SyncStatus} status @param {string} message @returns {SyncResult} */
  const result = (status, message) => ({ project: slug, status, message });
  const sourceRef = `refs/remotes/${SOURCE_REMOTE}/${BRANCH}`;
  const targetRef = `refs/remotes/${TARGET_REMOTE}/${BRANCH}`;

  const [fetchSource, fetchTarget] = await Promise.all([
    git(dir, ['fetch', SOURCE_REMOTE]),
    git(dir, ['fetch', TARGET_REMOTE]),
  ]);
  if (!fetchSource.ok) return result('failed', `fetch ${SOURCE_REMOTE}: ${fetchSource.stderr}`);
  if (!fetchTarget.ok) return result('failed', `fetch ${TARGET_REMOTE}: ${fetchTarget.stderr}`);

  const source = await git(dir, ['rev-parse', '--verify', sourceRef]);
  if (!source.ok) return result('failed', `${SOURCE_REMOTE}/${BRANCH} not found`);
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
 * @param {{ root?: string, project?: string, git?: GitRunner }} [options]
 * @returns {Promise<SyncResult[]>}
 */
export async function syncBrain({ root = workspaceRoot(), project, git = runGit } = {}) {
  const targets = await listTargets(root, git);
  const selected = project ? targets.filter((t) => t.slug === project) : targets;
  if (project && selected.length === 0) {
    return [
      {
        project,
        status: 'failed',
        message: `no brain project "${project}" with a ${TARGET_REMOTE} remote`,
      },
    ];
  }
  return Promise.all(selected.map(({ slug, dir }) => syncOne(slug, dir, git)));
}

/** @param {SyncResult[]} results @returns {string} */
export function formatResults(results) {
  if (results.length === 0) return `no brain project has a ${TARGET_REMOTE} remote`;
  return results.map((r) => `  [${r.project}] ${r.status}: ${r.message}`).join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const project = args.find((a) => !a.startsWith('--'));
  const results = await syncBrain({ project });
  console.log(asJson ? JSON.stringify(results, null, 2) : formatResults(results));
  const bad = results.some((r) => r.status === 'failed' || r.status === 'diverged');
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
