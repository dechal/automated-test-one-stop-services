import type { FastifyInstance } from 'fastify';
import { emulatorStatus, startEmulator, stopEmulators } from '../services/android-emulator.js';
import { markServiceTransition } from '../services/doctor.js';

export default async function androidEmulatorRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/android-emulator', async () => emulatorStatus());

  app.post<{ Body: { avd?: string } }>('/api/android-emulator/start', async (req, reply) => {
    const avd = req.body?.avd?.trim() ?? '';
    if (!avd) {
      reply.status(400);
      return { code: 'AVD_REQUIRED', message: 'Choose an AVD to start' };
    }
    const result = await startEmulator(avd);
    if (!result.ok) reply.status(400);
    markServiceTransition();
    return result;
  });

  app.post<{ Body: { serial?: string } }>('/api/android-emulator/stop', async (req, reply) => {
    const result = await stopEmulators(req.body?.serial?.trim() || undefined);
    if (!result.ok) reply.status(400);
    markServiceTransition();
    return result;
  });
}
