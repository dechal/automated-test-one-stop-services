#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GIT_TIMEOUT_MS = 10_000;
const MASK = '***';
const USERINFO_PATTERN = /^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i;
const TOOLS_DIR = 'tools';
const PROJECTS_DIR = 'projects';
const BRAIN_PROJECTS_DIR = ['brain', 'projects'];
/**
 * @typedef {'tool' | 'project' | 'brain'} RepoKind
 * @typedef {{ id: string, label: string, kind: RepoKind, dir: string }} RepoInfo
 * @typedef {{ name: string, url: string }} RemoteEntry
 * @typedef {{ id: string, label: string, kind: RepoKind, remotes: RemoteEntry[], error?: string }} RepoRemotes
 */
/** @returns {string} */
export function workspaceRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}
/** @param {string} url @returns {string} */
export function maskUrl(url) {
  return url.replace(USERINFO_PATTERN, `$1${MASK}@`);
}
/** @param {string} dir @returns {string[]} */
function subdirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}
/** @param {string} root @param {string} dir @param {RepoKind} kind @returns {RepoInfo} */
function repoInfo(root, dir, kind) {
  const id = path.relative(root, dir).split(path.sep).join('/');
  return { id, label: id, kind, dir };
}
/** @param {string} root @returns {RepoInfo[]} */
export function listRepos(root) {
  const toolsBase = path.join(root, TOOLS_DIR);
  /** @type {RepoInfo[]} */
  const found = [];
  for (const tool of subdirs(toolsBase)) {
    const toolDir = path.join(toolsBase, tool);
    found.push(repoInfo(root, toolDir, 'tool'));
    const projectsBase = path.join(toolDir, PROJECTS_DIR);
    for (const type of subdirs(projectsBase)) {
      for (const name of subdirs(path.join(projectsBase, type))) {
        found.push(repoInfo(root, path.join(projectsBase, type, name), 'project'));
      }
    }
  }
  const brainBase = path.join(root, ...BRAIN_PROJECTS_DIR);
  for (const slug of subdirs(brainBase)) {
    found.push(repoInfo(root, path.join(brainBase, slug), 'brain'));
  }
  return found.filter((r) => existsSync(path.join(r.dir, '.git')));
}
/** @param {string} cwd @param {string[]} args @returns {Promise<{ ok: boolean, stdout: string, stderr: string }>} */
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
/** @param {string} dir @returns {Promise<{ remotes: RemoteEntry[], error?: string }>} */
export async function readRemotes(dir) {
  const res = await runGit(dir, ['remote', '-v']);
  if (!res.ok) return { remotes: [], error: maskUrl(res.stderr) };
  /** @type {Map<string, RemoteEntry>} */
  const seen = new Map();
  for (const line of res.stdout.split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)\s+\((?:fetch|push)\)$/.exec(line.trim());
    if (!match?.[1] || !match[2]) continue;
    const key = `${match[1]}\n${match[2]}`;
    if (!seen.has(key)) seen.set(key, { name: match[1], url: maskUrl(match[2]) });
  }
  return { remotes: [...seen.values()] };
}
/** @param {string} root @returns {Promise<(RepoRemotes & { dir: string })[]>} */
export async function collectRemotes(root) {
  const repos = listRepos(root);
  return Promise.all(repos.map(async (repo) => ({ ...repo, ...(await readRemotes(repo.dir)) })));
}
/** @param {RepoRemotes[]} repos @returns {string} */
export function formatRemotes(repos) {
  const rows = repos.flatMap((r) =>
    r.remotes.length === 0
      ? [[r.id, '-', r.error ? `error: ${r.error}` : '(no remotes)']]
      : r.remotes.map((m) => [r.id, m.name, m.url]),
  );
  if (rows.length === 0) return 'no nested git repos found';
  const idWidth = Math.max(...rows.map((r) => r[0]?.length ?? 0));
  const nameWidth = Math.max(...rows.map((r) => r[1]?.length ?? 0));
  return rows
    .map(
      ([id = '', name = '', url = '']) =>
        `  ${id.padEnd(idWidth)}  ${name.padEnd(nameWidth)}  ${url}`,
    )
    .join('\n');
}
async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const rootIndex = args.indexOf('--root');
  const rootArg = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
  const root = rootArg ? path.resolve(rootArg) : workspaceRoot();
  const repos = await collectRemotes(root);
  console.log(asJson ? JSON.stringify(repos, null, 2) : formatRemotes(repos));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
