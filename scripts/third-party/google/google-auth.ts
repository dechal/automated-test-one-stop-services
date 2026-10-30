import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authenticate } from '@google-cloud/local-auth';
import { OAuth2Client } from 'google-auth-library';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/userinfo.email',
];

const CREDENTIALS_DIR = path.resolve(__dirname, 'credentials');
const CREDENTIALS_PATH = path.join(CREDENTIALS_DIR, 'credentials.json');
const TOKEN_PATH = path.join(CREDENTIALS_DIR, 'token.json');

/**
 * Non-throwing check: is a Google `credentials.json` present? Usage logging is a
 * best-effort side effect that must never crash a run, so it (and preflight
 * status) use this to skip gracefully instead of relying on authorize()'s throw.
 */
export function credentialsReady(): boolean {
  return fs.existsSync(CREDENTIALS_PATH);
}

/** Thrown by `authorize({ interactive: false })` when it cannot get a valid token without a browser. */
export const SILENT_AUTH_FAILED = 'SILENT_AUTH_FAILED';

export interface AuthorizeOptions {
  /**
   * When false, NEVER open the interactive browser consent flow. Used by
   * automated, unattended callers (usage logging fired from a test run): the
   * existing token is refreshed silently if possible, but a missing or
   * unrefreshable token throws `SILENT_AUTH_FAILED` so the caller can warn +
   * skip instead of blocking the run on a browser login. Default true — the
   * standalone `node google-auth.ts` admin re-auth still opens the browser.
   */
  interactive?: boolean;
}

export async function authorize(options: AuthorizeOptions = {}): Promise<OAuth2Client> {
  const interactive = options.interactive ?? true;

  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
      const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
      const oAuth2Client = new OAuth2Client(client_id, client_secret, redirect_uris[0]);
      oAuth2Client.setCredentials(tokens);

      // Attempt to retrieve a valid access token (refreshes if needed and possible)
      await oAuth2Client.getAccessToken();

      // googleapis bundles google-auth-library@10.5.0 while local-auth pulls
      // 10.9.0; the OAuth2Client types clash nominally (private `redirectUri`)
      // though they're the same class. Bridge — same cast the fallback path uses.
      return oAuth2Client as unknown as OAuth2Client;
    } catch (_err) {
      // The stored token could not be refreshed (revoked / offline / expired
      // refresh token). An unattended caller must not fall into the browser
      // flow — surface a typed failure so it can warn + skip.
      if (!interactive) {
        throw new Error(`${SILENT_AUTH_FAILED}: stored token could not be refreshed`);
      }
      console.warn('Token expired or invalid, re-authenticating...');
    }
  } else if (!interactive) {
    // No token on disk and we are not allowed to prompt — nothing to refresh.
    throw new Error(`${SILENT_AUTH_FAILED}: no stored token to refresh`);
  }

  function cleanupPort(port: number) {
    try {
      console.log(`🧹 Cleaning up port ${port} before auth...`);
      if (os.platform() === 'win32') {
        const output = execSync(`netstat -ano | findstr :${port}`).toString();
        const lines = output.split('\n');
        const pids = new Set<string>();
        for (const line of lines) {
          if (line.includes(`:${port}`) && line.includes('LISTENING')) {
            const parts = line.trim().split(/\s+/);
            const pid = parts[parts.length - 1];
            if (pid && pid !== '0') {
              pids.add(pid);
            }
          }
        }
        for (const pid of pids) {
          execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
        }
      } else {
        execSync(`lsof -t -i:${port} | xargs kill -9`, { stdio: 'ignore' });
      }
    } catch (_) {
      // Ignore, port is likely free
    }
  }

  // Check if credentials exist before calling authenticate
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `[ERROR] Google API credentials not found at: ${CREDENTIALS_PATH}\nPlease add credentials.json from Google Cloud Console to enable usage logging and authentication. The script cannot proceed without it.`,
    );
  }

  // Cleanup port 3000 to avoid EADDRINUSE crash
  cleanupPort(3000);

  // Fallback to authenticate flow
  const client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });

  if (client.credentials) {
    if (!fs.existsSync(CREDENTIALS_DIR)) {
      fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
    }
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(client.credentials, null, 2), 'utf8');
  }

  return client as unknown as OAuth2Client;
}

if (require.main === module) {
  authorize()
    .then(() => console.log('Google Auth Successful! Token is ready.'))
    .catch((err) => {
      // Exit non-zero so callers (the Hub "Connect Google" button) can detect
      // failure — console.error alone leaves the exit code at 0.
      console.error(err);
      process.exit(1);
    });
}
