import fs from 'node:fs';
import nodePath from 'node:path';
import type { FastifyInstance } from 'fastify';
import { artifactService } from '../services/artifacts.js';
import { getEnabledToolIds } from '../services/manifest-registry.js';
import { isUnderOutputs } from '../services/path-guard.js';

export async function artifactRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/artifacts', async () => {
    // Top-level children of outputs/ are tool folders — hide disabled tools.
    const enabledIds = await getEnabledToolIds();
    const tree = artifactService.browseAll();
    return { ...tree, children: tree.children.filter((c) => enabledIds.has(c.name)) };
  });

  app.get<{ Querystring: { tool: string; type: string; project: string } }>(
    '/api/artifacts/browse',
    async (req, reply) => {
      const enabledIds = await getEnabledToolIds();
      if (!enabledIds.has(req.query.tool)) {
        reply.status(404);
        return { code: 'NOT_FOUND', message: 'Tool is disabled or not installed' };
      }
      return artifactService.browse(req.query.tool, req.query.type, req.query.project);
    },
  );

  app.get<{ Querystring: { reportPath: string } }>('/api/artifacts/for-report', async (req) => {
    return artifactService.getForReport(req.query.reportPath);
  });

  app.get<{ Querystring: { path: string } }>('/api/artifacts/file', async (req, reply) => {
    const result = artifactService.readFile(req.query.path);
    if (!result) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'File not found or not readable' };
    }
    return result;
  });

  app.get<{ Querystring: { path: string } }>('/api/artifacts/info', async (req, reply) => {
    const result = artifactService.getFileInfo(req.query.path);
    if (!result) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'File not found' };
    }
    return result;
  });

  app.get<{ Querystring: { path: string } }>('/api/artifacts/serve', async (req, reply) => {
    const info = artifactService.serveInfo(req.query.path);
    if (!info) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'File not found' };
    }

    const { path: filePath, size, mimeType } = info;
    const rangeMatch = req.headers.range?.match(/bytes=(\d+)-(\d*)/);

    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1] as string, 10);
      const end = rangeMatch[2] ? Math.min(Number.parseInt(rangeMatch[2], 10), size - 1) : size - 1;
      if (Number.isNaN(start) || start > end || start >= size) {
        reply.status(416).header('Content-Range', `bytes */${size}`);
        return { code: 'RANGE_NOT_SATISFIABLE', message: 'Requested range not satisfiable' };
      }
      reply
        .status(206)
        .header('Content-Range', `bytes ${start}-${end}/${size}`)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Length', String(end - start + 1))
        .header('Content-Type', mimeType)
        .header('Cache-Control', 'public, max-age=3600');
      // Stream only the requested byte range — no full-file buffer in memory.
      return reply.send(fs.createReadStream(filePath, { start, end }));
    }

    reply
      .header('Content-Type', mimeType)
      .header('Content-Length', String(size))
      .header('Accept-Ranges', 'bytes')
      .header('Cache-Control', 'public, max-age=3600');
    return reply.send(fs.createReadStream(filePath));
  });

  app.get<{ Querystring: { path: string } }>('/api/artifacts/download-zip', async (req, reply) => {
    const dirPath = req.query.path;
    const resolved = nodePath.resolve(dirPath);

    if (!isUnderOutputs(resolved)) {
      reply.status(403);
      return { code: 'FORBIDDEN', message: 'Path outside outputs directory' };
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'Directory not found' };
    }

    // `archiver` is an optional, lazily-loaded CJS module. At runtime the
    // factory is on `.default` (Node's CJS→ESM interop), but @types/archiver v8
    // only declares classes/types — no callable default — so type the factory
    // explicitly to keep this both runtime-correct and type-checked.
    type ArchiverFactory = (
      format: string,
      options?: import('archiver').ArchiverOptions,
    ) => import('archiver').Archiver;
    const archiverMod = (await import('archiver').catch(() => null)) as {
      default: ArchiverFactory;
    } | null;
    if (!archiverMod) {
      reply.status(501);
      return {
        code: 'NOT_IMPLEMENTED',
        message: 'Install archiver: pnpm add -F @hub/server archiver',
      };
    }

    const archive = archiverMod.default('zip', { zlib: { level: 5 } });
    const folderName = nodePath.basename(resolved);

    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="${folderName}.zip"`);

    archive.directory(resolved, folderName);
    archive.finalize();

    return reply.send(archive);
  });

  /** DELETE /api/artifacts — delete a file or folder within outputs */
  app.delete<{ Querystring: { path: string } }>('/api/artifacts', async (req, reply) => {
    const targetPath = req.query.path;
    const resolved = nodePath.resolve(targetPath);

    if (!isUnderOutputs(resolved)) {
      reply.status(403);
      return { code: 'FORBIDDEN', message: 'Path outside outputs directory' };
    }

    if (!fs.existsSync(resolved)) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'Path not found' };
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      fs.rmSync(resolved, { recursive: true, force: true });
    } else {
      fs.unlinkSync(resolved);
    }

    // Drop the cached tree so the deletion is reflected on the next dashboard poll.
    artifactService.invalidateBrowseAll();
    return { ok: true, deleted: resolved };
  });
}

export default artifactRoutes;
