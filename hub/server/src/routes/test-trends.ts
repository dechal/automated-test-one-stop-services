import type { ToolId } from '@hub/shared';
import type { FastifyInstance } from 'fastify';
import { buildAllTestTrends, buildTestTrends } from '../services/test-trends.js';

export async function testTrendsRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/test-trends/all — per-test trends for every project that has any. */
  app.get('/api/test-trends/all', async () => buildAllTestTrends());

  app.get<{ Querystring: { tool?: ToolId; type?: string; project?: string } }>(
    '/api/test-trends',
    async (req, reply) => {
      const { tool, type, project } = req.query;
      if (!tool || !type || !project) {
        reply.status(400);
        return { code: 'BAD_REQUEST', message: 'tool, type and project are required' };
      }
      return buildTestTrends(tool, type, project);
    },
  );
}

export default testTrendsRoutes;
