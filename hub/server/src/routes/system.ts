import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { mapPool } from '../lib/map-pool.js';
import { rebuildHub, scheduleHubRestart } from '../services/hub-rebuild.js';
import { isUnderOutputs, isUnderWorkspace } from '../services/path-guard.js';
import { loadJson, saveJson } from '../services/persistence.js';
import { invalidateReportsCache, listReports } from '../services/reports.js';

const RETENTION_FILE = 'retention.json';

interface RetentionSettings {
  /** Days to keep reports. 0 = disabled (no auto-delete). */
  retentionDays: number;
  /** Whether auto-cleanup is enabled. */
  autoCleanup: boolean;
}

function loadRetention(): RetentionSettings {
  return loadJson<RetentionSettings>(RETENTION_FILE, { retentionDays: 30, autoCleanup: false });
}

function saveRetention(settings: RetentionSettings): void {
  saveJson(RETENTION_FILE, settings);
}

const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

/**
 * Parse a report timestamp into epoch ms.
 *
 * Reports are emitted by the test reporters under a directory tree where
 * the time component is encoded as `YYYY-Mon-DDTHH-MM` (with `-` instead
 * of `:` because Windows file paths cannot contain `:`). Native `Date`
 * does not understand the `-` separator, so we fall back to manual parsing.
 *
 * Returns `NaN` for unrecognised inputs; callers should treat that as
 * "unknown" and skip the record.
 */
function parseTimestamp(ts: string): number {
  const native = new Date(ts).getTime();
  if (!Number.isNaN(native)) return native;
  const match = ts.match(/^(\d{4})-(\w+)-(\d{1,2})T([\d:-]+)$/);
  if (!match) return Number.NaN;
  const [, year, monthStr, day, timeRaw] = match;
  const monthIdx = MONTHS[monthStr ?? ''];
  if (monthIdx === undefined) return Number.NaN;
  const timeParts = (timeRaw ?? '').replace(/-/g, ':').split(':');
  const hours = Number.parseInt(timeParts[0] ?? '0', 10);
  const minutes = Number.parseInt(timeParts[1] ?? '0', 10);
  return new Date(
    Number.parseInt(year ?? '0', 10),
    monthIdx,
    Number.parseInt(day ?? '1', 10),
    hours,
    minutes,
  ).getTime();
}

const CLEANUP_HISTORY_FILE = 'cleanup-history.json';
const MAX_CLEANUP_HISTORY = 50;
const CLEANUP_DELETE_PARALLELISM = 4;

interface CleanupRecord {
  timestamp: string;
  deleted: number;
  total: number;
  retentionDays: number;
  trigger: 'manual' | 'auto';
}

function loadCleanupHistory(): CleanupRecord[] {
  return loadJson<CleanupRecord[]>(CLEANUP_HISTORY_FILE, []);
}

function appendCleanupHistory(record: CleanupRecord): void {
  const history = loadCleanupHistory();
  history.unshift(record);
  if (history.length > MAX_CLEANUP_HISTORY) history.length = MAX_CLEANUP_HISTORY;
  saveJson(CLEANUP_HISTORY_FILE, history);
}

async function runCleanup(
  days: number,
  trigger: 'manual' | 'auto' = 'manual',
): Promise<{ deleted: number; total: number }> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const reports = await listReports();
  const targets: string[] = [];

  for (const report of reports) {
    // The lock exists precisely to survive this sweep — `/api/reports/lock` is
    // documented as "prevent auto-cleanup" — but the check was missing, so a
    // locked (and therefore any favourited) report was deleted on age like any
    // other. `locked` is already true for every favourite.
    if (report.locked) continue;
    const ts = parseTimestamp(report.timestamp);
    if (Number.isNaN(ts) || ts >= cutoff) continue;
    const htmlResultsDir = path.dirname(report.reportPath);
    const timeDir = path.dirname(htmlResultsDir);
    if (fs.existsSync(timeDir)) targets.push(timeDir);
  }

  const deletions = await mapPool(targets, CLEANUP_DELETE_PARALLELISM, async (dir) => {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  });
  const deleted = deletions.filter(Boolean).length;
  if (deleted > 0) invalidateReportsCache();

  if (deleted > 0 || trigger === 'manual') {
    appendCleanupHistory({
      timestamp: new Date().toISOString(),
      deleted,
      total: reports.length,
      retentionDays: days,
      trigger,
    });
  }

  return { deleted, total: reports.length };
}

let autoCleanupInterval: ReturnType<typeof setInterval> | null = null;

function startAutoCleanup(): void {
  if (autoCleanupInterval) return;
  autoCleanupInterval = setInterval(
    () => {
      const settings = loadRetention();
      if (settings.autoCleanup && settings.retentionDays > 0) {
        void runCleanup(settings.retentionDays, 'auto');
      }
    },
    60 * 60 * 1000,
  );
}

function stopAutoCleanup(): void {
  if (autoCleanupInterval) {
    clearInterval(autoCleanupInterval);
    autoCleanupInterval = null;
  }
}

const initialSettings = loadRetention();
if (initialSettings.autoCleanup) startAutoCleanup();

/**
 * Reveal a path in the OS file explorer (Windows: Explorer, macOS: Finder, Linux: xdg-open).
 * Restricted to paths under WORKSPACE_ROOT or OUTPUTS_DIR to avoid arbitrary disk access.
 */
function revealInExplorer(target: string): { ok: boolean; error?: string } {
  const resolved = path.resolve(target);
  if (!isUnderWorkspace(resolved) && !isUnderOutputs(resolved)) {
    return { ok: false, error: 'Path outside workspace' };
  }
  if (!fs.existsSync(resolved)) {
    return { ok: false, error: 'Path does not exist' };
  }

  try {
    if (process.platform === 'win32') {
      const stat = fs.statSync(resolved);
      const args = stat.isDirectory() ? [resolved] : ['/select,', resolved];
      const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore' });
      child.on('error', (err) => {
        // explorer.exe missing or PATH problem — log instead of dying silently.
        console.warn('[reveal] explorer.exe failed:', err.message);
      });
      child.unref();
    } else if (process.platform === 'darwin') {
      const child = spawn('open', ['-R', resolved], { detached: true, stdio: 'ignore' });
      child.on('error', (err) => console.warn('[reveal] open failed:', err.message));
      child.unref();
    } else {
      const stat = fs.statSync(resolved);
      const dir = stat.isDirectory() ? resolved : path.dirname(resolved);
      const child = spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' });
      child.on('error', (err) => console.warn('[reveal] xdg-open failed:', err.message));
      child.unref();
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { path: string } }>('/api/system/reveal', async (req, reply) => {
    const target = req.body?.path;
    if (!target) {
      reply.status(400);
      return { code: 'BAD_REQUEST', message: 'path is required' };
    }
    const result = revealInExplorer(target);
    if (!result.ok) {
      reply.status(400);
      return { code: 'REVEAL_FAILED', message: result.error ?? 'Unknown error' };
    }
    return { ok: true };
  });

  app.post<{ Body: { olderThanDays: number } }>('/api/system/cleanup', async (req, reply) => {
    const days = req.body?.olderThanDays;
    if (typeof days !== 'number' || days < 1) {
      reply.status(400);
      return { code: 'BAD_REQUEST', message: 'olderThanDays must be >= 1' };
    }
    return runCleanup(days);
  });

  app.get('/api/system/retention', async () => {
    return loadRetention();
  });

  app.put<{ Body: RetentionSettings }>('/api/system/retention', async (req) => {
    const { retentionDays, autoCleanup } = req.body ?? {};
    const settings: RetentionSettings = {
      retentionDays: typeof retentionDays === 'number' ? Math.max(1, retentionDays) : 30,
      autoCleanup: !!autoCleanup,
    };
    saveRetention(settings);
    if (settings.autoCleanup) {
      startAutoCleanup();
    } else {
      stopAutoCleanup();
    }
    return settings;
  });

  app.get('/api/system/cleanup-history', async () => {
    return loadCleanupHistory();
  });

  // -------------------------------------------------------------------------
  // /api/system/update — non-blocking. The build can take 30-60s, so we kick
  // it off in the background and let the client poll /api/system/update/status
  // and /api/health to know when it's safe to reload.
  // -------------------------------------------------------------------------

  app.post('/api/system/update', async (_req, reply) => {
    if (updateState.running) {
      reply.status(409);
      return { code: 'UPDATE_IN_PROGRESS', message: 'An update is already running' };
    }
    runUpdateInBackground();
    reply.status(202);
    return { ok: true, message: 'Update started in background' };
  });

  app.get('/api/system/update/status', async () => {
    return {
      running: updateState.running,
      stage: updateState.stage,
      error: updateState.error,
      finishedAt: updateState.finishedAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Background update orchestration.
// ---------------------------------------------------------------------------

interface UpdateState {
  running: boolean;
  stage: 'idle' | 'client' | 'server' | 'restarting' | 'done';
  error?: string;
  finishedAt?: string;
}

const updateState: UpdateState = { running: false, stage: 'idle' };

function runUpdateInBackground(): void {
  updateState.running = true;
  updateState.stage = 'client';
  updateState.error = undefined;
  updateState.finishedAt = undefined;

  // Run the workflow with no top-level await so the request handler returns
  // immediately. Errors are recorded onto updateState; the client polls the
  // status endpoint to find out.
  void (async () => {
    try {
      // Build + restart live in services/hub-rebuild.ts — /api/projects/pull-all
      // runs the same two steps, and this endpoint's `client`/`server` stage names
      // are its own public contract, so they are mapped here rather than there.
      const build = await rebuildHub((stage) => {
        updateState.stage = stage;
      });
      if (!build.ok) {
        updateState.error = `${build.failedAt} build failed: ${build.output}`;
        updateState.running = false;
        updateState.stage = 'idle';
        return;
      }

      updateState.stage = 'restarting';
      scheduleHubRestart((message) => {
        // launcher/node missing or PATH issue — leave the failure visible.
        updateState.error = message;
        updateState.running = false;
        updateState.stage = 'idle';
      });

      // We won't reach this in practice because the launcher restart recycles
      // the process, but mark "done" defensively in case it does not.
      updateState.stage = 'done';
      updateState.finishedAt = new Date().toISOString();
      updateState.running = false;
    } catch (err) {
      updateState.error = (err as Error).message;
      updateState.running = false;
      updateState.stage = 'idle';
    }
  })();
}

export default systemRoutes;
