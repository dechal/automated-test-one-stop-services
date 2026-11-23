import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { WORKSPACE_ROOT } from '../config.js';
import { runChild } from '../services/exec.js';

const PROJECT_SYNC_SCRIPT = path.join(WORKSPACE_ROOT, 'scripts', 'project-sync.mjs');
const PROJECT_SYNC_TIMEOUT_MS = 10 * 60_000;
const REPO_ID_PATTERN = /^(?!.*\.\.)[\w./-]+$/;
const SYNC_STATUSES = ['synced', 'already-up-to-date', 'diverged', 'failed'] as const;

export type ProjectSyncStatus = (typeof SYNC_STATUSES)[number];

export interface ProjectSyncResult {
  repo: string;
  status: ProjectSyncStatus;
  message: string;
}

function isSyncResult(value: unknown): value is ProjectSyncResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.repo === 'string' &&
    typeof v.message === 'string' &&
    SYNC_STATUSES.some((s) => s === v.status)
  );
}

function parseResults(stdout: string): ProjectSyncResult[] | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed) && parsed.every(isSyncResult) ? parsed : null;
  } catch {
    return null;
  }
}

export async function projectSyncRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { repo?: string } | undefined }>('/api/projects/sync', async (req, reply) => {
    const repo = req.body?.repo;
    if (repo !== undefined && !REPO_ID_PATTERN.test(repo)) {
      reply.status(400);
      return { code: 'BAD_REQUEST', message: 'Invalid repo id' };
    }
    const args = [PROJECT_SYNC_SCRIPT, '--json', ...(repo ? [repo] : [])];
    const res = await runChild(process.execPath, args, {
      cwd: WORKSPACE_ROOT,
      timeoutMs: PROJECT_SYNC_TIMEOUT_MS,
    });
    const results = parseResults(res.stdout);
    if (!results) {
      reply.status(500);
      return {
        code: 'PROJECT_SYNC_FAILED',
        message: res.timedOut
          ? 'Project sync timed out'
          : res.stderr.trim() || 'Project sync failed',
      };
    }
    return { results };
  });
}

export default projectSyncRoutes;
