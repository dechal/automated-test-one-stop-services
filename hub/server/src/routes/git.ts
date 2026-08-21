import type { FastifyInstance } from 'fastify';
import { WORKSPACE_ROOT } from '../config.js';
import { mapPool } from '../lib/map-pool.js';
import { runChild } from '../services/exec.js';
import { rebuildHub, scheduleHubRestart } from '../services/hub-rebuild.js';
import { listAllProjects } from '../services/scanner.js';

interface PullResult {
  project: string;
  tool: string;
  type: string;
  success: boolean;
  output: string;
}

interface GitStatusItem {
  project: string;
  tool: string;
  type: string;
  branch: string;
  localHash: string;
  remoteHash: string;
  hasUpdate: boolean;
  error?: string;
}

/** Concurrency cap for fanned-out git operations across many projects. */
const GIT_OP_CONCURRENCY = 4;

/** Run a `git ...` invocation in argv form — no shell, no injection. */
function git(cwd: string, args: string[]) {
  return runChild('git', args, { cwd });
}

/**
 * Compare local HEAD with remote tip via `git ls-remote` (no fetch).
 * Returns hasUpdate=true when remote SHA differs from local SHA.
 */
async function checkGitStatus(cwd: string): Promise<{
  branch: string;
  localHash: string;
  remoteHash: string;
  hasUpdate: boolean;
  error?: string;
}> {
  const branchRes = await git(cwd, ['symbolic-ref', '--short', 'HEAD']);
  const branch = branchRes.ok ? branchRes.stdout.trim() : '';
  if (!branch) {
    return {
      branch: '',
      localHash: '',
      remoteHash: '',
      hasUpdate: false,
      error: 'Detached HEAD or no branch',
    };
  }

  const [localRes, remoteRes] = await Promise.all([
    git(cwd, ['rev-parse', 'HEAD']),
    git(cwd, ['ls-remote', 'origin', `refs/heads/${branch}`]),
  ]);

  if (!localRes.ok) {
    return {
      branch,
      localHash: '',
      remoteHash: '',
      hasUpdate: false,
      error: localRes.stderr.trim() || 'rev-parse failed',
    };
  }
  if (!remoteRes.ok) {
    return {
      branch,
      localHash: localRes.stdout.trim(),
      remoteHash: '',
      hasUpdate: false,
      error: remoteRes.stderr.trim() || 'ls-remote failed',
    };
  }

  const localHash = localRes.stdout.trim();
  const remoteHash = remoteRes.stdout.split(/\s+/)[0]?.trim() ?? '';
  if (!remoteHash) {
    return {
      branch,
      localHash,
      remoteHash: '',
      hasUpdate: false,
      error: 'Remote branch not found',
    };
  }
  return { branch, localHash, remoteHash, hasUpdate: localHash !== remoteHash };
}

async function gitPull(cwd: string): Promise<{ success: boolean; output: string }> {
  const res = await git(cwd, ['pull']);
  return { success: res.ok, output: res.output.trim() };
}

export async function gitRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/git/status — compare local HEAD vs remote tip without fetching */
  app.get('/api/git/status', async () => {
    const items: GitStatusItem[] = [];

    const rootStatus = await checkGitStatus(WORKSPACE_ROOT);
    items.push({
      project: '(workspace)',
      tool: 'root',
      type: '',
      ...rootStatus,
    });

    const projects = (await listAllProjects()).filter((p) => p.isGitRepo);
    // Bounded concurrency — each call spawns 2-3 git processes; an
    // unbounded fan-out can saturate CPU and trip ssh-key dialogs.
    const subResults = await mapPool(projects, GIT_OP_CONCURRENCY, async (p) => {
      const s = await checkGitStatus(p.path);
      return { project: p.name, tool: p.tool, type: p.type, ...s };
    });
    items.push(...subResults);

    return { items, anyUpdate: items.some((i) => i.hasUpdate) };
  });

  // ---------------------------------------------------------------------------
  // POST /api/git/pull-all — non-blocking. Pulls workspace root + all
  // git-repo projects, then rebuilds hub (client → server) if hub-related
  // files changed, and restarts the Hub on successful rebuild.
  // Mirrors the staged approach of /api/system/update.
  // ---------------------------------------------------------------------------

  app.post('/api/git/pull-all', async (_req, reply) => {
    if (pullAllState.running) {
      reply.status(409);
      return { code: 'PULL_ALL_IN_PROGRESS', message: 'A pull-all is already running' };
    }
    runPullAllInBackground();
    reply.status(202);
    return { ok: true, message: 'Pull-all started in background' };
  });

  app.get('/api/git/pull-all/status', async () => {
    return {
      running: pullAllState.running,
      stage: pullAllState.stage,
      error: pullAllState.error,
      results: pullAllState.results,
      rebuilt: pullAllState.rebuilt,
      restarted: pullAllState.restarted,
      finishedAt: pullAllState.finishedAt,
    };
  });

  /** POST /api/git/pull — git pull a single project */
  app.post<{ Body: { tool: string; type: string; project: string } }>(
    '/api/git/pull',
    async (req, reply) => {
      const { tool, type, project } = req.body;

      if (tool === 'root') {
        const r = await gitPull(WORKSPACE_ROOT);
        return {
          project: '(workspace)',
          tool: 'root',
          type: '',
          success: r.success,
          output: r.output,
        };
      }

      const all = await listAllProjects();
      const match = all.find((p) => p.tool === tool && p.type === type && p.name === project);
      if (!match?.isGitRepo) {
        reply.status(404);
        return { code: 'NOT_FOUND', message: 'Project not found or not a git repo' };
      }

      const r = await gitPull(match.path);
      return {
        project: match.name,
        tool: match.tool,
        type: match.type,
        success: r.success,
        output: r.output,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Background pull-all orchestration (mirrors system.ts update pattern).
// ---------------------------------------------------------------------------

interface PullAllState {
  running: boolean;
  stage:
    | 'idle'
    | 'pulling'
    | 'building-shared'
    | 'building-client'
    | 'building-server'
    | 'restarting'
    | 'done';
  error?: string;
  results: PullResult[];
  rebuilt: boolean;
  restarted: boolean;
  finishedAt?: string;
}

const pullAllState: PullAllState = {
  running: false,
  stage: 'idle',
  results: [],
  rebuilt: false,
  restarted: false,
};

function runPullAllInBackground(): void {
  pullAllState.running = true;
  pullAllState.stage = 'pulling';
  pullAllState.error = undefined;
  pullAllState.results = [];
  pullAllState.rebuilt = false;
  pullAllState.restarted = false;
  pullAllState.finishedAt = undefined;

  void (async () => {
    try {
      // 1. Capture HEAD before pull
      const headBefore = await git(WORKSPACE_ROOT, ['rev-parse', 'HEAD']);
      const beforeSha = headBefore.stdout.trim();

      // 2. Pull workspace root
      const rootResult = await gitPull(WORKSPACE_ROOT);
      pullAllState.results.push({
        project: '(workspace)',
        tool: 'root',
        type: '',
        success: rootResult.success,
        output: rootResult.output,
      });

      // 3. Pull all sub-projects
      const projects = (await listAllProjects()).filter((p) => p.isGitRepo);
      if (projects.length > 0) {
        const subResults = await mapPool(projects, GIT_OP_CONCURRENCY, async (p) => {
          const r = await gitPull(p.path);
          return {
            project: p.name,
            tool: p.tool,
            type: p.type,
            success: r.success,
            output: r.output,
          };
        });
        pullAllState.results.push(...subResults);
      }

      // 4. Check if hub-related files changed — rebuild if so
      if (rootResult.success && beforeSha) {
        const headAfter = await git(WORKSPACE_ROOT, ['rev-parse', 'HEAD']);
        const afterSha = headAfter.stdout.trim();

        if (beforeSha !== afterSha) {
          const diffRes = await git(WORKSPACE_ROOT, [
            'diff',
            '--name-only',
            beforeSha,
            afterSha,
            '--',
            'hub/',
            'scripts/',
            'Taskfile.yml',
            'package.json',
            'pnpm-lock.yaml',
          ]);

          if (diffRes.stdout.trim()) {
            // Build + restart are shared with POST /api/system/update
            // (services/hub-rebuild.ts). What stays here is this endpoint's own
            // vocabulary: the `building-*` stage names and the `(hub-rebuild)`
            // result row the Projects page renders.
            const build = await rebuildHub((stage) => {
              pullAllState.stage = `building-${stage}`;
            });
            if (!build.ok) {
              pullAllState.error = `${build.failedAt} build failed: ${build.output}`;
              pullAllState.results.push({
                project: '(hub-rebuild)',
                tool: 'root',
                type: '',
                success: false,
                output: `${build.failedAt}: FAIL`,
              });
              pullAllState.running = false;
              pullAllState.stage = 'idle';
              return;
            }

            pullAllState.rebuilt = true;
            pullAllState.results.push({
              project: '(hub-rebuild)',
              tool: 'root',
              type: '',
              success: true,
              output: 'client: OK, server: OK',
            });

            pullAllState.stage = 'restarting';
            scheduleHubRestart((message) => {
              pullAllState.error = message;
              pullAllState.running = false;
              pullAllState.stage = 'idle';
            });

            pullAllState.restarted = true;
          }
        }
      }

      // Done
      pullAllState.stage = 'done';
      pullAllState.finishedAt = new Date().toISOString();
      pullAllState.running = false;
    } catch (err) {
      pullAllState.error = (err as Error).message;
      pullAllState.running = false;
      pullAllState.stage = 'idle';
    }
  })();
}

export default gitRoutes;
