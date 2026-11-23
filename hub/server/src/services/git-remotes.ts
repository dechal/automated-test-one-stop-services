import path from 'node:path';
import type { RemoteEntry, RepoKind, RepoRemotes } from '@hub/shared';
import { SCRIPTS_DIR, WORKSPACE_ROOT } from '../config.js';
import { SAFE_GIT_URL } from '../lib/safe-id.js';
import { runChild } from './exec.js';

const REMOTES_SCRIPT = path.join(SCRIPTS_DIR, 'remotes.mjs');
const LIST_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 15_000;
const VERIFY_TIMEOUT_MS = 15_000;
const PROTECTED_REMOTE = 'origin';
const MASK = '***';
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FILE_URL_PATTERN = /^file:\/\/\/[A-Za-z0-9._:/~%+-]+$/;
const HTTPS_USERINFO_PATTERN = /^https:\/\/[^/]*@/;
const USERINFO_PATTERN = /^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i;
const URL_IN_TEXT_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi;
const REPO_KINDS: readonly RepoKind[] = ['tool', 'project', 'brain'];

export interface RemoteFailure {
  ok: false;
  status: number;
  code: string;
  message: string;
}
export type RemoteResult = { ok: true } | RemoteFailure;
export type VerifyResult = { ok: true } | { ok: false; message: string };
export interface RepoWithDir extends RepoRemotes {
  dir: string;
}

function fail(status: number, code: string, message: string): RemoteFailure {
  return { ok: false, status, code, message };
}

export function validateRemoteName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    REMOTE_NAME_PATTERN.test(name) &&
    !name.includes('..') &&
    !name.endsWith('.') &&
    !name.endsWith('.lock')
  );
}

export function validateRemoteUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.startsWith('-')) return false;
  if (HTTPS_USERINFO_PATTERN.test(url)) return false;
  return SAFE_GIT_URL.test(url) || FILE_URL_PATTERN.test(url);
}

export function maskUrl(url: string): string {
  return url.replace(USERINFO_PATTERN, `$1${MASK}@`);
}

function maskText(text: string): string {
  return text.replace(URL_IN_TEXT_PATTERN, (u) => maskUrl(u));
}

function isRemoteEntry(value: unknown): value is RemoteEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string' && typeof v.url === 'string';
}

function isRepo(value: unknown): value is RepoWithDir {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.label === 'string' &&
    typeof v.dir === 'string' &&
    REPO_KINDS.some((k) => k === v.kind) &&
    Array.isArray(v.remotes) &&
    v.remotes.every(isRemoteEntry) &&
    (v.error === undefined || typeof v.error === 'string')
  );
}

export async function loadRepos(): Promise<RepoWithDir[] | null> {
  const res = await runChild(
    process.execPath,
    [REMOTES_SCRIPT, '--json', '--root', WORKSPACE_ROOT],
    { cwd: WORKSPACE_ROOT, timeoutMs: LIST_TIMEOUT_MS },
  );
  try {
    const parsed: unknown = JSON.parse(res.stdout);
    return Array.isArray(parsed) && parsed.every(isRepo) ? parsed : null;
  } catch {
    return null;
  }
}

export function publicRepos(repos: RepoWithDir[]): RepoRemotes[] {
  return repos.map(({ dir: _dir, ...rest }) => rest);
}

export async function findRepo(id: unknown): Promise<RepoWithDir | RemoteFailure> {
  const repos = await loadRepos();
  if (!repos) return fail(500, 'REMOTES_FAILED', 'Could not list repositories');
  const repo = typeof id === 'string' ? repos.find((r) => r.id === id) : undefined;
  return repo ?? fail(404, 'REPO_NOT_FOUND', 'Repository not found');
}

export async function verifyRemoteUrl(url: string): Promise<VerifyResult> {
  const res = await runChild('git', ['ls-remote', '--', url], {
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: 'https:ssh:file',
    },
    timeoutMs: VERIFY_TIMEOUT_MS,
  });
  if (res.ok) return { ok: true };
  const detail = res.timedOut ? 'timed out' : res.stderr.trim() || 'remote not reachable';
  return { ok: false, message: maskText(detail) };
}

async function git(dir: string, args: string[]) {
  return runChild('git', args, { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
}

async function liveUrl(dir: string, name: string): Promise<string | null> {
  const res = await git(dir, ['remote', 'get-url', '--', name]);
  return res.ok ? res.stdout.trim() : null;
}

function unreachable(verify: { message: string }): RemoteFailure {
  return fail(422, 'REMOTE_UNREACHABLE', verify.message);
}

export async function setUrl(dir: string, name: string, url: string): Promise<RemoteResult> {
  if ((await liveUrl(dir, name)) === null) {
    return fail(404, 'REMOTE_NOT_FOUND', 'Remote not found');
  }
  const verify = await verifyRemoteUrl(url);
  if (!verify.ok) return unreachable(verify);
  const res = await git(dir, ['remote', 'set-url', '--', name, url]);
  return res.ok ? { ok: true } : fail(500, 'REMOTE_FAILED', maskText(res.stderr.trim()));
}

export async function addRemote(dir: string, name: string, url: string): Promise<RemoteResult> {
  if ((await liveUrl(dir, name)) !== null) {
    return fail(409, 'REMOTE_EXISTS', 'Remote already exists');
  }
  const verify = await verifyRemoteUrl(url);
  if (!verify.ok) return unreachable(verify);
  const res = await git(dir, ['remote', 'add', '--', name, url]);
  return res.ok ? { ok: true } : fail(500, 'REMOTE_FAILED', maskText(res.stderr.trim()));
}

export async function deleteRemote(
  dir: string,
  name: string,
  confirmUrl: string,
): Promise<RemoteResult> {
  if (name === PROTECTED_REMOTE) {
    return fail(403, 'ORIGIN_PROTECTED', 'The origin remote cannot be deleted');
  }
  const current = await liveUrl(dir, name);
  if (current === null) return fail(404, 'REMOTE_NOT_FOUND', 'Remote not found');
  if (maskUrl(current) !== confirmUrl.trim()) {
    return fail(400, 'URL_MISMATCH', 'Confirmation URL does not match the remote URL');
  }
  const res = await git(dir, ['remote', 'remove', '--', name]);
  return res.ok ? { ok: true } : fail(500, 'REMOTE_FAILED', maskText(res.stderr.trim()));
}
