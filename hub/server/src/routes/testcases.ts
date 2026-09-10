import fs from 'node:fs';
import path from 'node:path';
import type {
  TestCaseCreateRequest,
  TestCaseDocGrouped,
  TestCaseEditRequest,
  TestCaseStatusSyncResult,
} from '@hub/shared';
import type { FastifyInstance } from 'fastify';
import { TOOLS_DIR } from '../config.js';
import { SAFE_ID } from '../lib/safe-id.js';
import { getHubUser } from '../services/hub-user.js';
import { isUnder } from '../services/path-guard.js';
import { runner } from '../services/runner.js';
import { listAllProjects } from '../services/scanner.js';
import {
  projectDirFor,
  resolveReportPath,
  resultMapFromReport,
} from '../services/testcase-status-sync.js';
import { createTestCaseDoc, writeResultXlsx } from '../services/testcase-xlsx.js';
import {
  addTestCaseRow,
  applyRunStatus,
  type EditAuthor,
  editTestCaseCell,
  listTestCaseDocs,
  listTestCaseModules,
  readTestCaseCsv,
  readTestCaseGrid,
  readTestCaseXlsx,
} from '../services/testcases.js';

/** A path segment that cannot traverse (no `..`, no backslash, no leading slash). */
const SAFE_SEGMENT = /^[A-Za-z0-9._/-]+$/;
function safeSegment(value: string | undefined): value is string {
  return !!value && SAFE_SEGMENT.test(value) && !value.includes('..');
}

/** A module folder name — one plain segment, no separators at all. */
const SAFE_MODULE = /^[A-Za-z0-9._-]+$/;

/** True when `p` is a `.csv`/`.xlsx` test-case doc safely inside `tools/`. */
function isDocPath(p: string | undefined): p is string {
  const lower = p?.toLowerCase() ?? '';
  return !!p && isUnder(TOOLS_DIR, p) && (lower.endsWith('.csv') || lower.endsWith('.xlsx'));
}

/** Derive tool/type/project from a doc under tools/<tool>/projects/<type>/<project>/... */
function projectFromDocPath(
  docPath: string,
): { tool: string; type: string; project: string } | null {
  const rel = path.relative(TOOLS_DIR, docPath).split(path.sep);
  if (rel.length < 4 || rel[1] !== 'projects') return null;
  const [tool, , type, project] = rel;
  return tool && type && project ? { tool, type, project } : null;
}

/** The Hub user as an edit author, or undefined when no name has been set yet. */
function currentAuthor(): EditAuthor | undefined {
  const user = getHubUser();
  return user ? { id: user.id, name: user.name } : undefined;
}

/**
 * Test-case document routes. Surfaces the test-case docs (xlsx/csv) that the QA
 * pipeline writes under a project's own folder — edits and synced run results go
 * to a `.edited.json` overlay beside each doc, never into the source file, and
 * every path is strictly guarded to `tools/` so a crafted `path` can never
 * escape the workspace tools tree.
 */
export async function testCaseRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/testcases?tool=&type=&project= — list test-case docs for a project. */
  app.get<{ Querystring: { tool?: string; type?: string; project?: string } }>(
    '/api/testcases',
    async (req, reply) => {
      const { tool, type, project } = req.query;
      if (!tool || !SAFE_ID.test(tool) || !safeSegment(type) || !safeSegment(project)) {
        reply.status(400);
        return { code: 'BAD_REQUEST', message: 'tool, type and project are required and safe' };
      }
      const projectDir = projectDirFor(tool, type, project);
      if (!isUnder(TOOLS_DIR, projectDir)) {
        reply.status(400);
        return { code: 'INVALID_PATH', message: 'resolved path escapes tools/' };
      }
      return listTestCaseDocs(projectDir);
    },
  );

  /**
   * GET /api/testcases/all — every test-case doc across every enabled tool /
   * type / project, each tagged with its tool/type/project so the client can
   * group and filter without one request per project. Reuses the same
   * project scan the rest of the Hub caches, then the same per-project doc
   * walk `/api/testcases` uses, so a doc lists here identically.
   */
  app.get('/api/testcases/all', async (): Promise<TestCaseDocGrouped[]> => {
    const projects = await listAllProjects();
    const grouped: TestCaseDocGrouped[] = [];
    for (const p of projects) {
      if (!isUnder(TOOLS_DIR, p.path)) continue;
      for (const doc of listTestCaseDocs(p.path)) {
        grouped.push({ ...doc, tool: p.tool, type: p.type, project: p.name });
      }
    }
    return grouped;
  });

  /** GET /api/testcases/modules?tool=&type=&project= — modules + which already own a doc. */
  app.get<{ Querystring: { tool?: string; type?: string; project?: string } }>(
    '/api/testcases/modules',
    async (req, reply) => {
      const { tool, type, project } = req.query;
      if (!tool || !SAFE_ID.test(tool) || !safeSegment(type) || !safeSegment(project)) {
        reply.status(400);
        return { code: 'BAD_REQUEST', message: 'tool, type and project are required and safe' };
      }
      const projectDir = projectDirFor(tool, type, project);
      if (!isUnder(TOOLS_DIR, projectDir)) {
        reply.status(400);
        return { code: 'INVALID_PATH', message: 'resolved path escapes tools/' };
      }
      return listTestCaseModules(projectDir);
    },
  );

  /**
   * POST /api/testcases/create — scaffold `docs/<module>/<module>_test-case.xlsx`
   * from the standard 18-column template. Refuses when the module already has a
   * doc (409), so a module can never end up with two sources of truth.
   */
  app.post<{ Body: Partial<TestCaseCreateRequest> }>(
    '/api/testcases/create',
    async (req, reply) => {
      const { tool, type, project, module: moduleName } = req.body ?? {};
      if (!tool || !SAFE_ID.test(tool) || !safeSegment(type) || !safeSegment(project)) {
        reply.status(400);
        return { code: 'BAD_REQUEST', message: 'tool, type and project are required and safe' };
      }
      if (!moduleName || !SAFE_MODULE.test(moduleName)) {
        reply.status(400);
        return { code: 'BAD_REQUEST', message: 'module must be a single safe folder name' };
      }
      const projectDir = projectDirFor(tool, type, project);
      if (!isUnder(TOOLS_DIR, projectDir) || !fs.existsSync(projectDir)) {
        reply.status(400);
        return { code: 'INVALID_PATH', message: 'project not found under tools/' };
      }
      // Only a module the project actually has may get a doc — otherwise a typo
      // silently creates a docs folder that matches no automation module.
      const known = listTestCaseModules(projectDir).find((m) => m.name === moduleName);
      if (!known) {
        reply.status(400);
        return { code: 'UNKNOWN_MODULE', message: `no module "${moduleName}" in this project` };
      }
      const created = await createTestCaseDoc(projectDir, moduleName);
      if ('error' in created) {
        reply.status(409);
        return {
          code: 'DUPLICATE',
          message: `module "${moduleName}" already has a test-case document`,
        };
      }
      return {
        name: path.basename(created.path),
        relPath: path.relative(projectDir, created.path).replace(/\\/g, '/'),
        path: created.path,
        ext: 'xlsx' as const,
        size: fs.statSync(created.path).size,
        edited: false,
      };
    },
  );

  /** GET /api/testcases/csv?path= — parsed CSV preview (guarded to tools/). */
  app.get<{ Querystring: { path?: string } }>('/api/testcases/csv', async (req, reply) => {
    const p = req.query.path;
    if (!p || !isUnder(TOOLS_DIR, p) || !p.toLowerCase().endsWith('.csv')) {
      reply.status(400);
      return { code: 'INVALID_PATH', message: 'path must be a .csv under tools/' };
    }
    const csv = readTestCaseCsv(p);
    if (!csv) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'CSV missing, too large, or unparseable' };
    }
    return csv;
  });

  /** GET /api/testcases/xlsx?path= — parsed workbook preview (guarded to tools/). */
  app.get<{ Querystring: { path?: string } }>('/api/testcases/xlsx', async (req, reply) => {
    const p = req.query.path;
    if (!p || !isUnder(TOOLS_DIR, p) || !p.toLowerCase().endsWith('.xlsx')) {
      reply.status(400);
      return { code: 'INVALID_PATH', message: 'path must be a .xlsx under tools/' };
    }
    const workbook = await readTestCaseXlsx(p);
    if (!workbook) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'workbook missing, too large, or unparseable' };
    }
    return workbook;
  });

  /**
   * GET /api/testcases/download?path=&variant=source|result
   *
   * `source` (default) streams the untouched doc — the clean template.
   * `result` renders the doc's current state (source + overlay: Hub edits and
   * synced run Status / Actual Result / Updated At) into a sibling
   * `<name>.result.xlsx` and streams that. The source file is never written to.
   */
  app.get<{ Querystring: { path?: string; variant?: string } }>(
    '/api/testcases/download',
    async (req, reply) => {
      const p = req.query.path;
      if (!isDocPath(p)) {
        reply.status(400);
        return { code: 'INVALID_PATH', message: 'path must be a .csv/.xlsx under tools/' };
      }
      if (!fs.existsSync(p)) {
        reply.status(404);
        return { code: 'NOT_FOUND', message: 'File not found' };
      }
      let filePath = p;
      if (req.query.variant === 'result') {
        const built = await writeResultXlsx(p);
        if (!built) {
          reply.status(404);
          return { code: 'NOT_FOUND', message: 'doc missing, too large, or unparseable' };
        }
        filePath = built;
      }
      reply.header('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
      reply.type('application/octet-stream');
      return reply.send(fs.createReadStream(filePath));
    },
  );

  /** GET /api/testcases/grid?path= — editable grid (prefers the .edited.json overlay). */
  app.get<{ Querystring: { path?: string } }>('/api/testcases/grid', async (req, reply) => {
    const p = req.query.path;
    if (!isDocPath(p)) {
      reply.status(400);
      return { code: 'INVALID_PATH', message: 'path must be a .csv/.xlsx under tools/' };
    }
    const grid = await readTestCaseGrid(p);
    if (!grid) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'doc missing, too large, or unparseable' };
    }
    return grid;
  });

  /**
   * POST /api/testcases/edit — set one cell, auto-stamping the row's Updated At
   * and Edited By (the Hub user's name) into the `.edited.json` overlay.
   */
  app.post<{ Body: Partial<TestCaseEditRequest> }>('/api/testcases/edit', async (req, reply) => {
    const { path: p, sheet, row, col, value } = req.body ?? {};
    if (!isDocPath(p)) {
      reply.status(400);
      return { code: 'INVALID_PATH', message: 'path must be a .csv/.xlsx under tools/' };
    }
    if (
      typeof sheet !== 'number' ||
      typeof row !== 'number' ||
      typeof col !== 'number' ||
      typeof value !== 'string'
    ) {
      reply.status(400);
      return {
        code: 'BAD_REQUEST',
        message: 'sheet, row, col (numbers) + value (string) required',
      };
    }
    const grid = await editTestCaseCell(p, sheet, row, col, value, currentAuthor());
    if (!grid) {
      reply.status(400);
      return { code: 'EDIT_FAILED', message: 'invalid target cell' };
    }
    return grid;
  });

  /** POST /api/testcases/add-row — append a blank row (writes .edited.json). */
  app.post<{ Body: { path?: string; sheet?: number } }>(
    '/api/testcases/add-row',
    async (req, reply) => {
      const { path: p, sheet } = req.body ?? {};
      if (!isDocPath(p)) {
        reply.status(400);
        return { code: 'INVALID_PATH', message: 'path must be a .csv/.xlsx under tools/' };
      }
      const grid = await addTestCaseRow(p, typeof sheet === 'number' ? sheet : 0, currentAuthor());
      if (!grid) {
        reply.status(404);
        return { code: 'NOT_FOUND', message: 'doc not found' };
      }
      return grid;
    },
  );

  /**
   * POST /api/testcases/sync-status — re-map the project's last run onto this
   * doc's rows. Runs already sync automatically when they finish; this is the
   * manual re-run of the same mapping (e.g. after editing case ids).
   */
  app.post<{ Body: { path?: string } }>('/api/testcases/sync-status', async (req, reply) => {
    const p = req.body?.path;
    if (!isDocPath(p)) {
      reply.status(400);
      return { code: 'INVALID_PATH', message: 'path must be a .csv/.xlsx under tools/' };
    }
    const target = projectFromDocPath(p);
    if (!target) {
      reply.status(400);
      return { code: 'INVALID_PATH', message: 'doc is not under a tools/ project' };
    }
    // Newest finished run of this project, whatever its outcome — a failed run
    // is exactly the one whose Fail statuses the doc should show.
    const latest = runner
      .getHistory()
      .filter(
        (r) =>
          r.request.tool === target.tool &&
          r.request.type === target.type &&
          r.request.project === target.project &&
          r.request.silent !== true &&
          !!r.endedAt,
      )
      .sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt))[0];
    const reportPath = latest ? await resolveReportPath(latest) : undefined;
    const result = await applyRunStatus(
      p,
      reportPath ? resultMapFromReport(reportPath) : {},
      latest?.endedAt ?? latest?.startedAt,
      currentAuthor(),
    );
    if (!result) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'doc missing or unreadable' };
    }
    return {
      ...result,
      runAt: reportPath ? (latest?.endedAt ?? latest?.startedAt ?? null) : null,
    } satisfies TestCaseStatusSyncResult;
  });
}

export default testCaseRoutes;
