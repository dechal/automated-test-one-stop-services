import type { EnvProfile, ToolId } from '@hub/shared';
import type { FastifyInstance } from 'fastify';
import { envProfileService } from '../services/env-profiles.js';

export async function envProfileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/env-profiles', async () => {
    return envProfileService.getAll();
  });

  app.get<{ Querystring: { tool: ToolId; type: string; project: string } }>(
    '/api/env-profiles/by-project',
    async (req) => {
      return envProfileService.getByProject(req.query.tool, req.query.type, req.query.project);
    },
  );

  app.post<{ Body: Omit<EnvProfile, 'id' | 'createdAt' | 'updatedAt'> }>(
    '/api/env-profiles',
    async (req, reply) => {
      // `create` carries tool/type/project/entries, so validate the body directly.
      const probe = {
        ...req.body,
        id: '',
        createdAt: '',
        updatedAt: '',
      } as EnvProfile;
      if (req.body.allowOutsideTemplate !== true) {
        const { extraKeys } = envProfileService.validate(probe);
        if (extraKeys.length > 0) {
          reply.status(400);
          return { code: 'OUTSIDE_TEMPLATE_KEYS', message: 'Keys outside template', extraKeys };
        }
      }
      return envProfileService.create(req.body);
    },
  );

  app.put<{ Params: { id: string }; Body: Partial<EnvProfile> }>(
    '/api/env-profiles/:id',
    async (req, reply) => {
      // A partial PUT may omit tool/type/project/entries, so merge the patch
      // over the stored record before validating — validating the raw partial
      // makes getTemplate resolve the wrong project and flags every key extra.
      const existing = envProfileService.getById(req.params.id);
      if (!existing) {
        reply.status(404);
        return { code: 'NOT_FOUND', message: 'Profile not found' };
      }
      const merged: EnvProfile = { ...existing, ...req.body };
      if (merged.allowOutsideTemplate !== true) {
        const { extraKeys } = envProfileService.validate(merged);
        if (extraKeys.length > 0) {
          reply.status(400);
          return { code: 'OUTSIDE_TEMPLATE_KEYS', message: 'Keys outside template', extraKeys };
        }
      }
      const result = envProfileService.update(req.params.id, req.body);
      if (!result) {
        reply.status(404);
        return { code: 'NOT_FOUND', message: 'Profile not found' };
      }
      return result;
    },
  );

  app.delete<{ Params: { id: string } }>('/api/env-profiles/:id', async (req, reply) => {
    const ok = envProfileService.delete(req.params.id);
    if (!ok) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'Profile not found' };
    }
    return { success: true };
  });

  app.post<{ Params: { id: string } }>('/api/env-profiles/:id/apply', async (req, reply) => {
    const result = envProfileService.apply(req.params.id);
    if (result.success) return { success: true };
    switch (result.code) {
      case 'NOT_FOUND':
        reply.status(404);
        return { code: 'NOT_FOUND', message: 'Profile not found' };
      case 'OUTSIDE_TEMPLATE_KEYS':
        reply.status(400);
        return {
          code: 'OUTSIDE_TEMPLATE_KEYS',
          message: 'Keys outside template',
          extraKeys: result.extraKeys,
        };
      default:
        reply.status(400);
        return { code: 'APPLY_FAILED', message: result.error };
    }
  });

  app.post<{ Params: { id: string } }>('/api/env-profiles/:id/default', async (req, reply) => {
    const result = envProfileService.setDefault(req.params.id);
    if (!result) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'Profile not found' };
    }
    return result;
  });

  app.get<{ Querystring: { tool: ToolId; type: string; project: string } }>(
    '/api/env-profiles/default',
    async (req) => {
      const defaultId = envProfileService.getDefault(
        req.query.tool,
        req.query.type,
        req.query.project,
      );
      return { defaultId };
    },
  );

  app.get<{ Querystring: { id: string } }>('/api/env-profiles/validate', async (req, reply) => {
    const profile = envProfileService.getById(req.query.id);
    if (!profile) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'Profile not found' };
    }
    return envProfileService.validate(profile);
  });

  app.post<{
    Body: { tool: ToolId; type: string; project: string; name: string; environment: string };
  }>('/api/env-profiles/capture', async (req, reply) => {
    const { tool, type, project, name, environment } = req.body;
    const result = envProfileService.captureFromEnv(tool, type, project, name, environment);
    if (!result) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'Project .env not found' };
    }
    return result;
  });

  app.get<{ Querystring: { tool: ToolId; type: string; project: string } }>(
    '/api/env-profiles/active',
    async (req) => {
      const activeId = envProfileService.getActiveProfile(
        req.query.tool,
        req.query.type,
        req.query.project,
      );
      return { activeId };
    },
  );

  app.get<{ Querystring: { tool: ToolId; type: string; project: string } }>(
    '/api/env-profiles/template',
    async (req) => {
      return envProfileService.getTemplate(req.query.tool, req.query.type, req.query.project);
    },
  );
}

export default envProfileRoutes;
