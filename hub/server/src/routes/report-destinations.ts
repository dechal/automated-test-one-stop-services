import { type ReportDestination, reportDirError, reportDirKey } from '@hub/shared';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { loadJson, saveJson } from '../services/persistence.js';

const DATASET = 'report-destinations';

function load(): ReportDestination[] {
  return loadJson<ReportDestination[]>(DATASET, []);
}

export default async function reportDestinationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/report-destinations', async () => load());

  app.post<{ Body: { name?: string; path?: string } }>(
    '/api/report-destinations',
    async (req, reply) => {
      const dir = req.body?.path?.trim() ?? '';
      const name = req.body?.name?.trim() ?? '';
      if (name === '') {
        reply.status(400);
        return { code: 'NAME_REQUIRED', message: 'Give the folder a name' };
      }
      const error = reportDirError(dir, new Date());
      if (error) {
        reply.status(400);
        return { code: 'INVALID_REPORT_DIR', message: error };
      }
      const destinations = load();
      const key = reportDirKey(dir);
      if (destinations.some((d) => reportDirKey(d.path) === key)) {
        reply.status(409);
        return { code: 'DUPLICATE_DESTINATION', message: `Already saved: ${dir}` };
      }
      const entry: ReportDestination = {
        id: nanoid(8),
        name,
        path: dir,
        createdAt: new Date().toISOString(),
      };
      saveJson(DATASET, [...destinations, entry]);
      return entry;
    },
  );

  app.put<{ Params: { id: string }; Body: { name?: string } }>(
    '/api/report-destinations/:id',
    async (req, reply) => {
      const name = req.body?.name?.trim() ?? '';
      if (name === '') {
        reply.status(400);
        return { code: 'NAME_REQUIRED', message: 'Give the folder a name' };
      }
      const destinations = load();
      const target = destinations.find((d) => d.id === req.params.id);
      if (!target) {
        reply.status(404);
        return { code: 'NOT_FOUND', message: 'Destination not found' };
      }
      const updated: ReportDestination = { ...target, name };
      saveJson(
        DATASET,
        destinations.map((d) => (d.id === target.id ? updated : d)),
      );
      return updated;
    },
  );

  app.delete<{ Params: { id: string } }>('/api/report-destinations/:id', async (req, reply) => {
    const destinations = load();
    const remaining = destinations.filter((d) => d.id !== req.params.id);
    if (remaining.length === destinations.length) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'Destination not found' };
    }
    saveJson(DATASET, remaining);
    return { ok: true };
  });
}
