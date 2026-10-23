import fs from 'node:fs';
import path from 'node:path';
import type { CredentialStatus } from '@hub/shared';
import { SCRIPTS_DIR } from '../config.js';
import { SAFE_ID } from '../lib/safe-id.js';

/**
 * Third-party integrations live under `scripts/third-party/<tool>/`. A tool
 * that needs secrets ships a `credentials/` folder (e.g. Google OAuth's
 * `credentials.json`). This service scans those folders and writes uploaded
 * credential files — the same pattern works for any future third-party tool.
 */
function thirdPartyDir(): string {
  return path.join(SCRIPTS_DIR, 'third-party');
}

/** Canonical credential filename expected inside each `<tool>/credentials/`. */
const CREDENTIALS_FILENAME = 'credentials.json';

/**
 * OAuth token filename written after a successful interactive authentication
 * (e.g. Google). Its presence means "this tool has been connected", separate
 * from `credentials.json` (the app credentials the user uploads).
 */
const TOKEN_FILENAME = 'token.json';

/** Resolve a tool's credentials directory, guarding against path traversal. */
function credentialsDir(tool: string): string {
  const base = path.resolve(thirdPartyDir());
  const resolved = path.resolve(base, tool, 'credentials');
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error('INVALID_TOOL_PATH');
  }
  return resolved;
}

/**
 * List every third-party tool that declares a `credentials/` folder, with
 * whether its `credentials.json` is present. Tools without a credentials
 * folder are omitted — they don't need uploaded secrets.
 */
export function listCredentialStatus(): CredentialStatus[] {
  const root = thirdPartyDir();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .filter((d) => fs.existsSync(path.join(root, d.name, 'credentials')))
    .map((d) => ({
      tool: d.name,
      hasCredentials: fs.existsSync(path.join(root, d.name, 'credentials', CREDENTIALS_FILENAME)),
    }))
    .sort((a, b) => a.tool.localeCompare(b.tool));
}

/**
 * True once `<tool>/credentials/token.json` exists — i.e. the user has completed
 * the interactive OAuth flow at least once. Presence only (no validity check):
 * an expired-but-refreshable token still counts as connected, and a dead token
 * surfaces at run time via the best-effort logging script's warn+skip.
 */
export function hasToken(tool: string): boolean {
  let dir: string;
  try {
    dir = credentialsDir(tool);
  } catch {
    return false;
  }
  return fs.existsSync(path.join(dir, TOKEN_FILENAME));
}

export type SaveCredentialsResult =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      readonly code: 'INVALID_TOOL_NAME' | 'NO_CREDENTIALS_DIR' | 'INVALID_JSON';
      readonly message: string;
    };

/**
 * Persist an uploaded `credentials.json` for `tool`. The content must be valid
 * JSON. The tool must already expose a `credentials/` folder (the convention
 * that marks it as needing credentials).
 */
export function saveCredentials(tool: string, content: string): SaveCredentialsResult {
  if (!SAFE_ID.test(tool)) {
    return {
      ok: false,
      code: 'INVALID_TOOL_NAME',
      message: 'tool name contains unsafe characters',
    };
  }

  let dir: string;
  try {
    dir = credentialsDir(tool);
  } catch {
    return { ok: false, code: 'INVALID_TOOL_NAME', message: 'tool path is invalid' };
  }

  if (!fs.existsSync(dir)) {
    return {
      ok: false,
      code: 'NO_CREDENTIALS_DIR',
      message: `scripts/third-party/${tool} has no credentials/ folder`,
    };
  }

  try {
    JSON.parse(content);
  } catch {
    return { ok: false, code: 'INVALID_JSON', message: 'uploaded file is not valid JSON' };
  }

  const target = path.join(dir, CREDENTIALS_FILENAME);
  // Service-account keys are secrets: create owner-only (0600) instead of
  // inheriting the umask (commonly 0644, world-readable on a shared machine).
  // `mode` only applies on creation, so chmod an existing file too. Windows
  // ignores POSIX modes — the call is a harmless no-op there.
  fs.writeFileSync(target, content, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // Filesystems without POSIX permissions (e.g. some Windows mounts) — the
    // file is still written; permission hardening is best-effort.
  }
  return { ok: true, path: path.relative(SCRIPTS_DIR, target) };
}
