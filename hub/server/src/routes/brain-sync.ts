import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { WORKSPACE_ROOT } from '../config.js';
import { runChild } from '../services/exec.js';

const BRAIN_SYNC_SCRIPT = path.join(WORKSPACE_ROOT, 'scripts', 'brain-sync.mjs');
const BRAIN_SYNC_TIMEOUT_MS = 10 * 60_000;
const SLUG_PATTERN = /^[\w.-]+$/;
const SYNC_STATUSES = ['synced', 'already-up-to-date', 'diverged', 'failed'] as const;

export type BrainSyncStatus = (typeof SYNC_STATUSES)[number];

export interface BrainSyncResult {
  project: string;
  status: BrainSyncStatus;
  message: string;
}

function isSyncResult(value: unknown): value is BrainSyncResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.project === 'string' &&
    typeof v.message === 'string' &&
    SYNC_STATUSES.some((s) => s === v.status)
  );
}

function parseResults(stdout: string): BrainSyncResult[] | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed) && parsed.every(isSyncResult) ? parsed : null;
  } catch {
    return null;
  }
}

export async function brainSyncRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { project?: string } | undefined }>('/api/brain/sync', async (req, reply) => {
    const project = req.body?.project;
    if (project !== undefined && !SLUG_PATTERN.test(project)) {
      reply.status(400);
      return { code: 'BAD_REQUEST', message: 'Invalid project slug' };
    }
    const args = [BRAIN_SYNC_SCRIPT, '--json', ...(project ? [project] : [])];
    const res = await runChild(process.execPath, args, {
      cwd: WORKSPACE_ROOT,
      timeoutMs: BRAIN_SYNC_TIMEOUT_MS,
    });
    const results = parseResults(res.stdout);
    if (!results) {
      reply.status(500);
      return {
        code: 'BRAIN_SYNC_FAILED',
        message: res.timedOut ? 'Brain sync timed out' : res.stderr.trim() || 'Brain sync failed',
      };
    }
    return { results };
  });
}

export default brainSyncRoutes;
