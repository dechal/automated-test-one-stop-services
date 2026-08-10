import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { BASH_PATH, WORKSPACE_ROOT } from '../config.js';
import {
  getComposeServiceStatus,
  invalidateDockerStatusCache,
  isDockerRunning,
} from '../services/docker.js';
import { runChild } from '../services/exec.js';

type ServiceName = 'influxdb' | 'grafana';
const VALID_SERVICES: ServiceName[] = ['influxdb', 'grafana'];

/** Map service name to the task command that starts it. */
const SERVICE_START_CMD: Record<ServiceName, string> = {
  influxdb: 'task k6:start-grafana TRACK=none',
  grafana: 'task k6:start-grafana TRACK=none',
};

/** Run a `docker compose ...` command. */
function compose(args: string[]) {
  return runChild('docker', ['compose', ...args], { cwd: WORKSPACE_ROOT });
}

/** Run a task recipe via bash (required on Windows). */
function taskCmd(line: string) {
  return runChild(BASH_PATH, ['-lc', line], { cwd: WORKSPACE_ROOT });
}

export async function dockerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/docker/status', async () => {
    const dockerRunning = await isDockerRunning();
    const services: Record<string, string> = {};

    if (dockerRunning) {
      const statuses = await Promise.all(VALID_SERVICES.map((s) => getComposeServiceStatus(s)));
      VALID_SERVICES.forEach((svc, idx) => {
        services[svc] = statuses[idx] ?? 'unknown';
      });
    }

    return { dockerRunning, services };
  });

  app.post('/api/docker/start-desktop', async () => {
    try {
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', ['-a', 'Docker'], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('systemctl', ['start', 'docker'], { detached: true, stdio: 'ignore' }).unref();
      }
      invalidateDockerStatusCache();
      return { success: true, message: 'Docker Desktop starting...' };
    } catch (err) {
      return { success: false, message: (err as Error).message };
    }
  });

  app.post<{ Body: { service: ServiceName } }>('/api/docker/service/start', async (req, reply) => {
    const { service } = req.body;
    if (!VALID_SERVICES.includes(service)) {
      reply.status(400);
      return { code: 'INVALID_SERVICE', message: `Invalid service: ${service}` };
    }
    if (!(await isDockerRunning())) {
      reply.status(400);
      return {
        code: 'DOCKER_NOT_RUNNING',
        message: 'Docker is not running. Start Docker Desktop first.',
      };
    }
    const result = await taskCmd(SERVICE_START_CMD[service]);
    invalidateDockerStatusCache();
    return { success: result.ok, output: result.output };
  });

  app.post<{ Body: { service: ServiceName } }>('/api/docker/service/stop', async (req, reply) => {
    const { service } = req.body;
    if (!VALID_SERVICES.includes(service)) {
      reply.status(400);
      return { code: 'INVALID_SERVICE', message: `Invalid service: ${service}` };
    }
    const result = await compose(['stop', service]);
    invalidateDockerStatusCache();
    return { success: result.ok, output: result.output };
  });

  app.post<{ Body: { service: ServiceName } }>(
    '/api/docker/service/restart',
    async (req, reply) => {
      const { service } = req.body;
      if (!VALID_SERVICES.includes(service)) {
        reply.status(400);
        return { code: 'INVALID_SERVICE', message: `Invalid service: ${service}` };
      }
      if (!(await isDockerRunning())) {
        reply.status(400);
        return { code: 'DOCKER_NOT_RUNNING', message: 'Docker is not running.' };
      }
      const result = await compose(['restart', service]);
      invalidateDockerStatusCache();
      return { success: result.ok, output: result.output };
    },
  );

  app.post('/api/docker/start-all', async (_req, reply) => {
    if (!(await isDockerRunning())) {
      reply.status(400);
      return { code: 'DOCKER_NOT_RUNNING', message: 'Docker is not running.' };
    }
    const results = await Promise.all([taskCmd(SERVICE_START_CMD.grafana)]);
    invalidateDockerStatusCache();
    const allOk = results.every((r) => r.ok);
    const output = results.map((r) => r.output).join('\n');
    return { success: allOk, output };
  });

  app.post('/api/docker/stop-all', async () => {
    const result = await compose(['stop']);
    invalidateDockerStatusCache();
    return { success: result.ok, output: result.output };
  });
}

export default dockerRoutes;
