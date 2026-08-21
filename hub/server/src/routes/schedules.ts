import type { CustomCommand, RunRequest } from '@hub/shared';
import type { FastifyInstance } from 'fastify';
import { validateCustomCommand } from '../services/custom-command-builder.js';
import { getEnabledToolIds } from '../services/manifest-registry.js';
import { scheduler } from '../services/scheduler.js';

export async function scheduleRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/schedules — list schedules for ENABLED tools only.
   *  Schedules targeting a disabled/uninstalled tool are hidden. CUSTOM schedules
   *  own no tool, so they are never filtered out. */
  app.get('/api/schedules', async () => {
    const enabledIds = await getEnabledToolIds();
    return scheduler
      .getAll()
      .filter((s) => s.command !== undefined || enabledIds.has(s.config.tool));
  });

  /** POST /api/schedules — create a new schedule (tool run, or custom command) */
  app.post<{ Body: { name: string; cron: string; config: RunRequest; command?: CustomCommand } }>(
    '/api/schedules',
    async (req, reply) => {
      // Validate a custom command HERE, at create time, so the user sees the
      // rejection — a cron tick would only bury it in a log.
      const invalid = req.body.command && validateCustomCommand(req.body.command);
      if (invalid) {
        reply.status(400);
        return invalid;
      }
      try {
        const schedule = scheduler.create(
          req.body.name,
          req.body.cron,
          req.body.config,
          req.body.command,
        );
        return schedule;
      } catch (err) {
        reply.status(400);
        return { code: 'INVALID_CRON', message: (err as Error).message };
      }
    },
  );

  /** PUT /api/schedules/:id — update a schedule */
  app.put<{
    Params: { id: string };
    Body: {
      name?: string;
      cron?: string;
      config?: RunRequest;
      command?: CustomCommand;
      enabled?: boolean;
    };
  }>('/api/schedules/:id', async (req, reply) => {
    const invalid = req.body.command && validateCustomCommand(req.body.command);
    if (invalid) {
      reply.status(400);
      return invalid;
    }
    try {
      const schedule = scheduler.update(req.params.id, req.body);
      if (!schedule) {
        reply.status(404);
        return { code: 'NOT_FOUND', message: 'Schedule not found' };
      }
      return schedule;
    } catch (err) {
      reply.status(400);
      return { code: 'INVALID_CRON', message: (err as Error).message };
    }
  });

  /** POST /api/schedules/:id/toggle — enable/disable a schedule */
  app.post<{ Params: { id: string } }>('/api/schedules/:id/toggle', async (req, reply) => {
    const schedule = scheduler.toggle(req.params.id);
    if (!schedule) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'Schedule not found' };
    }
    return schedule;
  });

  /** DELETE /api/schedules/:id — delete a schedule */
  app.delete<{ Params: { id: string } }>('/api/schedules/:id', async (req, reply) => {
    const ok = scheduler.delete(req.params.id);
    if (!ok) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'Schedule not found' };
    }
    return { success: true };
  });
}

export default scheduleRoutes;
