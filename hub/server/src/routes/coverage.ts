import type { ToolId } from '@hub/shared';
import type { FastifyInstance } from 'fastify';
import { buildAllCoverage, buildCoverage } from '../services/coverage.js';

export async function coverageRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/coverage/all — coverage for every project with documented cases. */
  app.get('/api/coverage/all', async () => buildAllCoverage());

  app.get<{ Querystring: { tool?: ToolId; type?: string; project?: string } }>(
    '/api/coverage',
    async (req, reply) => {
      const { tool, type, project } = req.query;
      if (!tool || !type || !project) {
        reply.status(400);
        return { code: 'BAD_REQUEST', message: 'tool, type and project are required' };
      }
      return buildCoverage(tool, type, project);
    },
  );
}

export default coverageRoutes;
