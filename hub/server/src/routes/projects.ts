import type { ToolId } from '@hub/shared';
import type { FastifyInstance } from 'fastify';
import { BASH_PATH, WORKSPACE_ROOT } from '../config.js';
import { SAFE_ID } from '../lib/safe-id.js';
import { runChild } from '../services/exec.js';
import { getEnabledTools } from '../services/manifest-registry.js';
import { type ProjectCleanupResult, removeProjectCascade } from '../services/project-cleanup.js';
import {
  invalidateProjectCache,
  listAllProjects,
  listProjects,
  listSections,
  listTypes,
} from '../services/scanner.js';
import { withResync } from '../services/workspace-sync.js';

/**
 * Identifier validator. We accept names/types that are alphanumeric with
 * `-`, `_`, `.`, and `/` (so type folders like `web/sub` work). Anything else
 * could escape the shell or write outside the projects directory.
 */
const SAFE_IDENT = /^[a-zA-Z0-9._/-]+$/;

/**
 * Validator for a git URL. Accepts:
 *   - https://host/path[.git]
 *   - git@host:path[.git]
 *   - ssh://git@host[:port]/path[.git]
 * Rejects anything containing whitespace, shell metacharacters, or NUL.
 */
const SAFE_GIT_URL = /^(?:https:\/\/|ssh:\/\/git@|git@)[A-Za-z0-9._:/~@?=+-]+(?:\.git)?$/;

/**
 * A single safe path segment for a derived project folder: starts alphanumeric,
 * no slashes and no leading dot, so a derived name can never traverse out of
 * the projects directory (`SAFE_IDENT` intentionally allows `/` for nested
 * type folders, which is too permissive for an auto-derived folder name).
 */
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Derive a project folder name from a git URL's last path segment, e.g.
 * `https://host/org/repo.git` -> `repo`, `git@host:org/repo.git` -> `repo`.
 * Mirrors the UI promise that the folder name "defaults to the repository name".
 */
function deriveRepoName(url: string): string {
  const cleaned = url.replace(/\/+$/, '');
  const seg = cleaned.slice(Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf(':')) + 1);
  return seg.replace(/\.git$/i, '');
}

/** Validate a tool id and confirm it is known + enabled. Returns an error reply
 *  payload or `null` when the tool is valid. */
async function rejectUnknownTool(
  tool: string | undefined,
  reply: { status: (code: number) => unknown },
): Promise<{ code: string; message: string } | null> {
  if (!tool || !SAFE_ID.test(tool)) {
    reply.status(400);
    return { code: 'INVALID_TOOL_NAME', message: 'tool id contains unsafe characters' };
  }
  const manifest = (await getEnabledTools()).find((t) => t.id === tool);
  if (!manifest) {
    reply.status(404);
    return { code: 'TOOL_NOT_FOUND', message: `Tool '${tool}' is not installed or not enabled` };
  }
  return null;
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/projects — list all projects across all tools */
  app.get('/api/projects', async () => {
    return listAllProjects();
  });

  /** GET /api/projects/types?tool=playwright */
  app.get<{ Querystring: { tool: ToolId } }>('/api/projects/types', async (req) => {
    return await listTypes(req.query.tool);
  });

  /** GET /api/projects/list?tool=playwright&type=web */
  app.get<{ Querystring: { tool?: ToolId; type?: string } }>('/api/projects/list', async (req) => {
    const { tool, type } = req.query;
    if (!tool || !type) {
      return (await listAllProjects()).map((p) => p.name);
    }
    return await listProjects(tool, type);
  });

  /** GET /api/projects/sections?project=my-project (section-axis tools) */
  app.get<{ Querystring: { project: string; tool?: ToolId } }>(
    '/api/projects/sections',
    async (req) => {
      return await listSections(req.query.project, req.query.tool);
    },
  );

  /**
   * POST /api/projects/create — create a new project via `task create-project`.
   * The Task recipe forwards args after `--`; we still route through bash so
   * the wrapper script's POSIX semantics work on Windows. We validate every
   * interpolated value first to eliminate shell injection.
   */
  app.post<{ Body: { tool: ToolId; type?: string; name: string } }>(
    '/api/projects/create',
    async (req, reply) => {
      const { tool, type, name } = req.body ?? {};
      if (!tool || !name) {
        reply.status(400);
        return { code: 'BAD_REQUEST', message: 'tool and name are required' };
      }
      const toolErr = await rejectUnknownTool(tool, reply);
      if (toolErr) return toolErr;
      if (!SAFE_IDENT.test(name) || (type && !SAFE_IDENT.test(type))) {
        reply.status(400);
        return {
          code: 'INVALID_IDENT',
          message: 'name/type may only contain letters, digits, `_`, `-`, `.`, `/`',
        };
      }

      const args = [
        '-lc',
        `task create-project -- --tool=${tool} --name=${name}${type ? ` --type=${type}` : ''}`,
      ];
      const res = await runChild(BASH_PATH, args, { cwd: WORKSPACE_ROOT });

      if (!res.ok) {
        reply.status(400);
        return {
          success: false,
          code: 'CREATE_FAILED',
          message: res.output.trim() || `create-project failed (exit ${res.code})`,
          output: res.output,
        };
      }
      invalidateProjectCache();
      return { success: true, output: res.output };
    },
  );

  /**
   * POST /api/projects/clone — clone a git repo into the correct project path.
   * Uses `git` argv directly (no shell), so the URL/name/type cannot inject
   * additional commands.
   */
  app.post<{ Body: { tool: ToolId; type: string; url: string; name?: string } }>(
    '/api/projects/clone',
    async (req, reply) => {
      const { tool, type, url, name } = req.body ?? {};
      if (!tool || !type || !url) {
        reply.status(400);
        return { code: 'BAD_REQUEST', message: 'tool, type, url are required' };
      }
      const toolErr = await rejectUnknownTool(tool, reply);
      if (toolErr) return toolErr;
      if (!SAFE_IDENT.test(type)) {
        reply.status(400);
        return { code: 'INVALID_IDENT', message: 'type contains unsafe characters' };
      }
      if (!SAFE_GIT_URL.test(url)) {
        reply.status(400);
        return { code: 'INVALID_URL', message: 'url must be https://, ssh://, or git@host:path' };
      }

      // Resolve the destination folder. The folder name is optional in the UI
      // ("defaults to the repository name"), so derive it from the URL when
      // omitted — otherwise we'd point git at the existing, non-empty type
      // directory and the clone would always fail.
      const provided = name?.trim();
      if (provided && !SAFE_IDENT.test(provided)) {
        reply.status(400);
        return { code: 'INVALID_IDENT', message: 'name contains unsafe characters' };
      }
      const folder = provided || deriveRepoName(url);
      if (!folder || (!provided && !REPO_NAME.test(folder))) {
        reply.status(400);
        return {
          code: 'INVALID_NAME',
          message: 'Could not derive a folder name from the URL — please enter one explicitly.',
        };
      }

      const targetDir = `tools/${tool}/projects/${type}/${folder}`;
      const res = await runChild('git', ['clone', url, targetDir], { cwd: WORKSPACE_ROOT });

      if (!res.ok) {
        reply.status(400);
        return {
          success: false,
          code: 'CLONE_FAILED',
          message: res.output.trim() || `git clone failed (exit ${res.code})`,
          output: res.output,
        };
      }
      invalidateProjectCache();
      return { success: true, output: res.output };
    },
  );

  /**
   * POST /api/projects/remove — permanently delete a project and EVERYTHING
   * associated with it (folder, outputs/artifacts, history, schedules,
   * bookmarks, project-scoped webhooks, env profiles, last-run status).
   *
   * Irreversible, so it is gated behind a typed confirmation: the client must
   * send `confirm` equal to `tool/type/project` (e.g. `k6/performance/demo`),
   * mirroring GitLab's "type the path to delete" guard. A workspace resync runs
   * afterwards so generated artefacts (docker-compose.yml, pipeline.json) no
   * longer reference the removed project.
   */
  app.post<{ Body: { tool: ToolId; type: string; project: string; confirm: string } }>(
    '/api/projects/remove',
    async (req, reply) => {
      const { tool, type, project, confirm } = req.body ?? {};
      if (!tool || !type || !project) {
        reply.status(400);
        return { code: 'BAD_REQUEST', message: 'tool, type and project are required' };
      }
      if (!SAFE_ID.test(tool) || !SAFE_IDENT.test(type) || !SAFE_IDENT.test(project)) {
        reply.status(400);
        return { code: 'INVALID_IDENT', message: 'tool/type/project contains unsafe characters' };
      }
      // Typed-confirmation guard — must match `tool/type/project` exactly.
      const expected = `${tool}/${type}/${project}`;
      if (confirm !== expected) {
        reply.status(400);
        return {
          code: 'CONFIRMATION_MISMATCH',
          message: `Type "${expected}" to confirm removal`,
        };
      }
      // The project must actually exist (and not be a template) before we delete.
      const projects = await listProjects(tool, type);
      if (!projects.includes(project)) {
        reply.status(404);
        return { code: 'PROJECT_NOT_FOUND', message: `Project '${expected}' not found` };
      }

      const result = await withResync<ProjectCleanupResult>(() =>
        removeProjectCascade({ tool, type, project }),
      );
      invalidateProjectCache();
      return result;
    },
  );
}

export default projectRoutes;
