import type { EnvEntry, UsageLoggingStatus } from '@hub/shared';
import type { FastifyInstance } from 'fastify';
import { WORKSPACE_ROOT } from '../config.js';
import { hasToken, listCredentialStatus } from '../services/credentials.js';
import { getScriptsEnv, saveEnvFile } from '../services/env-editor.js';
import { runChild } from '../services/exec.js';

/**
 * Google Sheet usage-logging setup + on/off toggle for the Projects page.
 *
 * The guided flow a non-technical user follows (no terminal, ever):
 *   1. upload Google `credentials.json`  (credentials service)
 *   2. connect Google — POST /authenticate runs the interactive OAuth flow and
 *      writes `token.json`
 *   3. logging turns ON automatically once ready (FORCE_TRACK=true)
 *
 * Readiness is derived (never hand-configured): credentials uploaded +
 * `SPREADSHEET_ID` in scripts/.env + a Google `token.json` present. The toggle
 * flips `FORCE_TRACK` but REFUSES to turn logging on until it is actually ready,
 * so a non-technical user can't enable a dead feature. Mirrors the graceful,
 * best-effort contract of the logging script
 * (see scripts/third-party/google/google-sheet-usage-log.ts).
 */

/** The single third-party tool this flow authenticates. */
const GOOGLE_TOOL = 'google';

/** Interactive OAuth can involve a browser consent screen — allow the user time. */
const AUTH_TIMEOUT_MS = 180_000;

/** Trimmed value of an env key from the scripts/.env entries, or ''. */
function envValue(entries: EnvEntry[], key: string): string {
  return entries.find((e) => e.key === key)?.value?.trim() ?? '';
}

function computeStatus(): UsageLoggingStatus {
  const hasCredentials = listCredentialStatus().some(
    (t) => t.tool === GOOGLE_TOOL && t.hasCredentials,
  );
  const { entries } = getScriptsEnv();
  const hasSpreadsheetId = envValue(entries, 'SPREADSHEET_ID').length > 0;
  const tokenPresent = hasToken(GOOGLE_TOOL);
  const forceTrack = envValue(entries, 'FORCE_TRACK').toLowerCase() === 'true';
  return {
    hasCredentials,
    hasSpreadsheetId,
    hasToken: tokenPresent,
    forceTrack,
    ready: hasCredentials && hasSpreadsheetId && tokenPresent,
    sheetName: envValue(entries, 'SHEET_NAME') || 'logs',
  };
}

/** Persist FORCE_TRACK into scripts/.env, preserving real entries (not blank template keys). */
function setForceTrack(enabled: boolean): void {
  const base = getScriptsEnv().entries.filter((e) => !e.fromTemplate);
  const value = enabled ? 'true' : 'false';
  const next = base.some((e) => e.key === 'FORCE_TRACK')
    ? base.map((e) => (e.key === 'FORCE_TRACK' ? { ...e, value } : e))
    : [...base, { key: 'FORCE_TRACK', value, fromTemplate: false }];
  saveEnvFile('scripts', '', '', next);
}

/**
 * Only one interactive auth may run at a time — the OAuth helper binds a local
 * redirect port, so concurrent runs would collide. Module-scoped so it is
 * shared across requests for the lifetime of the server process.
 */
let authInFlight = false;

export async function usageLoggingRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/usage-logging/status — derived readiness + current on/off state. */
  app.get('/api/usage-logging/status', async () => computeStatus());

  /** POST /api/usage-logging/enabled { enabled } — flip FORCE_TRACK (guarded). */
  app.post<{ Body: { enabled?: boolean } }>('/api/usage-logging/enabled', async (req, reply) => {
    const enabled = req.body?.enabled === true;
    const status = computeStatus();

    // Guard: never enable a feature that can't work — tell the user what's missing.
    if (enabled && !status.ready) {
      reply.status(400);
      return {
        code: 'NOT_READY',
        message: !status.hasCredentials
          ? 'Upload Google credentials.json before enabling usage logging.'
          : !status.hasSpreadsheetId
            ? 'Set SPREADSHEET_ID in scripts/.env before enabling usage logging.'
            : 'Connect your Google account before enabling usage logging.',
      };
    }

    setForceTrack(enabled);
    return computeStatus();
  });

  /**
   * POST /api/usage-logging/authenticate — run the interactive Google OAuth flow
   * (opens a browser on THIS machine; the Hub is local-only) and write token.json.
   * On success, auto-enable logging when everything is ready, so the guided flow
   * "upload → connect → it's on" completes with no extra click.
   */
  app.post('/api/usage-logging/authenticate', async (_req, reply) => {
    if (authInFlight) {
      reply.status(409);
      return { code: 'AUTH_IN_PROGRESS', message: 'A Google connection is already in progress.' };
    }
    // Can't authenticate without the app credentials in place first.
    if (!computeStatus().hasCredentials) {
      reply.status(400);
      return { code: 'NO_CREDENTIALS', message: 'Upload Google credentials.json first.' };
    }

    authInFlight = true;
    try {
      const result = await runChild('tsx', ['scripts/third-party/google/google-auth.ts'], {
        cwd: WORKSPACE_ROOT,
        shell: process.platform === 'win32',
        timeoutMs: AUTH_TIMEOUT_MS,
      });
      if (!result.ok) {
        reply.status(result.timedOut ? 504 : 500);
        return {
          code: result.timedOut ? 'AUTH_TIMEOUT' : 'AUTH_FAILED',
          message: result.timedOut
            ? 'Google connection timed out. Complete the browser consent, then try again.'
            : `Google connection failed: ${result.stderr || result.output}`.trim(),
        };
      }

      // Connected. Turn logging on by default once fully ready (upload → connect
      // → on), so the user doesn't have to flip the switch themselves.
      const status = computeStatus();
      if (status.ready && !status.forceTrack) setForceTrack(true);
      return computeStatus();
    } finally {
      authInFlight = false;
    }
  });
}

export default usageLoggingRoutes;
