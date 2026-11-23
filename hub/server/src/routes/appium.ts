import type { FastifyInstance } from 'fastify';
import { appiumServer } from '../services/appium-server.js';
import { markServiceTransition } from '../services/doctor.js';
import { localServiceOwners } from '../services/tool-services.js';

/**
 * Host-Appium control (mobile testing). Lets the Hub start/stop/install the
 * local Appium server with no terminal commands — see services/appium-server.ts.
 */
export async function appiumRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/appium/status', async () => {
    const requiredBy = await localServiceOwners('appium');
    const required = requiredBy.length > 0;
    const installed = required ? await appiumServer.isInstalled() : false;
    return { ...appiumServer.status(), installed, required, requiredBy };
  });

  app.post('/api/appium/start', async (_req, reply) => {
    if (!(await appiumServer.isInstalled())) {
      reply.status(400);
      return {
        code: 'APPIUM_NOT_INSTALLED',
        message: 'Appium is not installed on the host. Run Install first.',
      };
    }
    const result = await appiumServer.start();
    markServiceTransition();
    return result;
  });

  app.post('/api/appium/stop', async () => {
    const result = await appiumServer.stop();
    markServiceTransition();
    return result;
  });

  app.post('/api/appium/install', async () => {
    const res = await appiumServer.install();
    markServiceTransition();
    return { success: res.ok, output: res.output };
  });
}

export default appiumRoutes;
