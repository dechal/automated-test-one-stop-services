import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolId } from '@hub/shared';
import type { FastifyInstance } from 'fastify';
import { SERVER_PKG_DIR } from '../config.js';
import { isUnderOutputs } from '../services/path-guard.js';
import {
  invalidateReportsCache,
  listReports,
  lockReport,
  unlockReport,
} from '../services/reports.js';
import { type ArtifactTestInfo, artifactTestIndex } from '../services/run-compare.js';
import {
  getTraceProcess,
  killTraceProcess,
  registerTraceProcess,
  unregisterTraceProcess,
} from '../services/trace-processes.js';

export interface ArtifactGroup {
  /** Test folder name on disk (e.g. "ta-negative-E2E-...") — never renamed. */
  name: string;
  traces: { name: string; path: string }[];
  videos: { name: string; path: string }[];
  /**
   * Readable identity of the test that produced this folder, joined from the
   * run's `results.json`. Absent when the run kept no parseable report, in which
   * case the UI falls back to `name`.
   */
  test?: ArtifactTestInfo;
}

export interface ReportArtifacts {
  groups: ArtifactGroup[];
}

const MIME_MAP: Record<string, string> = {
  '.zip': 'application/zip',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/reports?tool=playwright&type=web&project=example&status=success */
  app.get<{
    Querystring: { tool?: ToolId; type?: string; project?: string; status?: 'success' | 'error' };
  }>('/api/reports', async (req) => {
    return await listReports(req.query);
  });

  /**
   * POST /api/reports/open-file  { path: <absolute-path> }
   * Open the report in the OS default app (the browser opens it as a real
   * `file://` path). A web page at localhost cannot navigate to `file://`
   * itself — browsers block that — so the server launches it via the OS, the
   * same way traces / Docker are launched elsewhere. Path must be under
   * OUTPUTS_DIR. Best-effort: spawn errors are logged, not surfaced.
   */
  app.post<{ Body: { path: string } }>('/api/reports/open-file', async (req, reply) => {
    const reportPath = req.body?.path;
    if (!reportPath || !isUnderOutputs(reportPath)) {
      reply.status(403);
      return { code: 'FORBIDDEN', message: 'Access denied' };
    }
    if (!fs.existsSync(reportPath)) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'Report file not found' };
    }

    // cross-OS "open with default app": Windows `start`, macOS `open`, Linux `xdg-open`
    const opener =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', reportPath], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          })
        : process.platform === 'darwin'
          ? spawn('open', [reportPath], { detached: true, stdio: 'ignore' })
          : spawn('xdg-open', [reportPath], { detached: true, stdio: 'ignore' });
    opener.on('error', (err) => {
      console.warn('[reports/open-file] failed to launch:', err.message);
    });
    opener.unref();

    return { opened: true };
  });

  /** POST /api/reports/artifacts — list trace/video files for a report */
  app.post<{ Body: { path: string } }>('/api/reports/artifacts', async (req, reply) => {
    const reportPath = req.body?.path;

    if (!reportPath || !isUnderOutputs(reportPath) || !fs.existsSync(reportPath)) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'Report not found' };
    }

    // Report is at: .../html-results/index.html
    // Artifacts are sibling folders: .../evidences/<test-name>/{trace.zip, video.webm}
    const htmlResultsDir = path.dirname(reportPath);
    const runDir = path.dirname(htmlResultsDir);

    const artifacts: ReportArtifacts = { groups: [] };

    if (fs.existsSync(runDir)) {
      const siblings = fs.readdirSync(runDir, { withFileTypes: true });
      for (const sibling of siblings) {
        if (
          sibling.isDirectory() &&
          sibling.name !== 'html-results' &&
          sibling.name !== 'file-logs'
        ) {
          scanArtifactsGrouped(path.join(runDir, sibling.name), artifacts);
        }
      }
    }

    // Label each folder with its case. Display-time only: the directory keeps
    // the name Playwright gave it, so traces, videos and any path the user
    // copies still resolve.
    const testIndex = artifactTestIndex(reportPath);
    if (testIndex) {
      for (const group of artifacts.groups) {
        const info = testIndex[group.name];
        if (info) group.test = info;
      }
    }

    return artifacts;
  });

  /** GET /api/reports/artifact/serve?path=<absolute-path> — stream a single artifact file */
  app.get<{ Querystring: { path: string } }>('/api/reports/artifact/serve', async (req, reply) => {
    const filePath = req.query.path;

    if (!filePath || !isUnderOutputs(filePath)) {
      reply.status(403);
      return { code: 'FORBIDDEN', message: 'Access denied' };
    }
    if (!fs.existsSync(filePath)) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'Artifact not found' };
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_MAP[ext] ?? 'application/octet-stream';
    const stat = fs.statSync(filePath);

    reply
      .type(mime)
      .header('Content-Length', String(stat.size))
      .header('Accept-Ranges', 'bytes')
      .header('Access-Control-Allow-Origin', '*')
      .header('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
    return reply.send(fs.createReadStream(filePath));
  });

  /** DELETE /api/reports?path=<absolute-path> — permanently delete a report directory */
  app.delete<{ Querystring: { path: string } }>('/api/reports', async (req, reply) => {
    const reportPath = req.query.path;

    if (!reportPath || !isUnderOutputs(reportPath)) {
      reply.status(403);
      return { code: 'FORBIDDEN', message: 'Access denied' };
    }
    if (!fs.existsSync(reportPath)) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'Report not found' };
    }

    // Report is at: .../html-results/index.html
    // We delete the TIME folder (parent of html-results), not the day folder.
    const htmlResultsDir = path.dirname(reportPath);
    const timeDir = path.dirname(htmlResultsDir);
    fs.rmSync(timeDir, { recursive: true, force: true });
    invalidateReportsCache();

    return { success: true };
  });

  /** POST /api/reports/lock — lock a report to prevent auto-cleanup */
  app.post<{ Body: { path: string } }>('/api/reports/lock', async (req, reply) => {
    const reportPath = req.body?.path;
    if (!reportPath || !isUnderOutputs(reportPath) || !fs.existsSync(reportPath)) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'Report not found' };
    }
    lockReport(reportPath);
    return { locked: true };
  });

  /** POST /api/reports/unlock — unlock a report to allow auto-cleanup */
  app.post<{ Body: { path: string } }>('/api/reports/unlock', async (req, reply) => {
    const reportPath = req.body?.path;
    if (!reportPath || !isUnderOutputs(reportPath) || !fs.existsSync(reportPath)) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'Report not found' };
    }
    unlockReport(reportPath);
    return { locked: false };
  });

  // =========================================================================
  // Trace viewer process management
  // =========================================================================
  // Process registry lives in `services/trace-processes.ts` so the graceful
  // shutdown handler in index.ts can tear down every viewer regardless of
  // which route created it.

  /** POST /api/reports/trace/open — spawn playwright show-trace in background */
  app.post<{ Body: { path: string } }>('/api/reports/trace/open', async (req, reply) => {
    const tracePath = req.body?.path;
    if (!tracePath || !isUnderOutputs(tracePath)) {
      reply.status(403);
      return { code: 'FORBIDDEN', message: 'Access denied' };
    }
    if (!fs.existsSync(tracePath)) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'Trace file not found' };
    }

    const existing = getTraceProcess(tracePath);
    if (existing) {
      try {
        process.kill(existing.pid, 0); // 0 = check liveness
        return { running: true, pid: existing.pid };
      } catch {
        unregisterTraceProcess(tracePath);
      }
    }

    // `pnpm exec` (not `dlx`) runs the `playwright` version this package already
    // declares — no registry download on first use, works offline, and the trace
    // viewer matches the browser build the tool provisioned. Hence the cwd: the
    // binary is resolved from @hub/server's own node_modules.
    const child = spawn('pnpm', ['exec', 'playwright', 'show-trace', tracePath], {
      detached: false,
      stdio: 'ignore',
      shell: process.platform === 'win32',
      windowsHide: false,
      cwd: SERVER_PKG_DIR,
    });

    if (!child.pid) {
      reply.status(500);
      return { code: 'SPAWN_FAILED', message: 'Failed to start trace viewer' };
    }

    registerTraceProcess(tracePath, { pid: child.pid, process: child });
    child.on('exit', () => unregisterTraceProcess(tracePath));

    return { running: true, pid: child.pid };
  });

  /** POST /api/reports/trace/close — kill a running trace viewer */
  app.post<{ Body: { path: string } }>('/api/reports/trace/close', async (req, reply) => {
    const tracePath = req.body?.path;
    if (!tracePath) {
      reply.status(400);
      return { code: 'BAD_REQUEST', message: 'path required' };
    }

    const entry = getTraceProcess(tracePath);
    if (!entry) return { running: false };

    await killTraceProcess(entry);
    unregisterTraceProcess(tracePath);
    return { running: false };
  });

  /** POST /api/reports/trace/status — check if trace viewer is running */
  app.post<{ Body: { path: string } }>('/api/reports/trace/status', async (req) => {
    const tracePath = req.body?.path;
    if (!tracePath) return { running: false };
    const entry = getTraceProcess(tracePath);
    if (!entry) return { running: false };

    try {
      process.kill(entry.pid, 0);
      return { running: true, pid: entry.pid };
    } catch {
      unregisterTraceProcess(tracePath);
      return { running: false };
    }
  });
}

/** Scan a results directory and group artifacts by test folder */
function scanArtifactsGrouped(dir: string, out: ReportArtifacts): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const group: ArtifactGroup = { name: entry.name, traces: [], videos: [] };
      scanFilesIntoGroup(full, group);
      if (group.traces.length > 0 || group.videos.length > 0) {
        out.groups.push(group);
      }
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === '.zip' || ext === '.webm' || ext === '.mp4') {
        let otherGroup = out.groups.find((g) => g.name === '_root');
        if (!otherGroup) {
          otherGroup = { name: '_root', traces: [], videos: [] };
          out.groups.push(otherGroup);
        }
        if (ext === '.zip') {
          otherGroup.traces.push({ name: entry.name, path: full });
        } else {
          otherGroup.videos.push({ name: entry.name, path: full });
        }
      }
    }
  }
}

/** Recursively scan files within a test folder into a group */
function scanFilesIntoGroup(dir: string, group: ArtifactGroup): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanFilesIntoGroup(full, group);
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === '.zip') {
        group.traces.push({ name: entry.name, path: full });
      } else if (ext === '.webm' || ext === '.mp4') {
        group.videos.push({ name: entry.name, path: full });
      }
    }
  }
}

export default reportRoutes;
