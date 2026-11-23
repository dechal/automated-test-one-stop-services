import type { FastifyInstance } from 'fastify';
import { appiumServer } from '../services/appium-server.js';
import { isLocalServiceRequired } from '../services/tool-services.js';

/**
 * Host-Appium control (mobile testing). Lets the Hub start/stop/install the
 * local Appium server with no terminal commands — see services/appium-server.ts.
 */
export async function appiumRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/appium/status', async () => {
    const required = await isLocalServiceRequired('appium');
    const installed = required ? await appiumServer.isInstalled() : false;
    return { ...appiumServer.status(), installed, required };
  });

  app.post('/api/appium/start', async (_req, reply) => {
    if (!(await appiumServer.isInstalled())) {
      reply.status(400);
      return {
        code: 'APPIUM_NOT_INSTALLED',
        message: 'Appium is not installed on the host. Run Install first.',
      };
    }
    return appiumServer.start();
  });

  app.post('/api/appium/stop', async () => {
    return appiumServer.stop();
  });

  app.post('/api/appium/install', async () => {
    const res = await appiumServer.install();
    return { success: res.ok, output: res.output };
  });
}

export default appiumRoutes;
