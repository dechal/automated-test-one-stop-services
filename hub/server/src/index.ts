import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

// Register tsx ESM loader so dynamic import() of .ts files with .js extension
// specifiers resolves correctly (needed for scripts/manifests/ dynamic imports).
//
// Use tsx's own register() API rather than node:module's register('tsx/esm', …).
// The latter calls tsx's `initialize` hook with no data payload, which makes tsx
// throw "tsx must be loaded with --import instead of --loader" and crash-loops the
// hub in the built runtime. tsx/esm/api's register() sets up the MessagePort/data internally.
register();

import autoload from '@fastify/autoload';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { validatorCompiler } from 'fastify-type-provider-zod';
import { ALLOWED_ORIGINS, CLIENT_DIST_DIR, HOST, PORT, SCRIPTS_DIR } from './config.js';
import { appiumServer } from './services/appium-server.js';
import { getDb } from './services/db.js';
import { isDockerRunning } from './services/docker.js';
import { historyStore } from './services/history-store.js';
import { flushPersistence } from './services/persistence.js';
import { startPostRunPipeline } from './services/post-run.js';
import { runner } from './services/runner.js';
import { killAllTraceProcesses } from './services/trace-processes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.join(here, 'routes');

const FORCE_TRACK_RE = /^FORCE_TRACK=["']?(.+?)["']?\s*$/m;

/** Read scripts/.env once at startup; no need to re-parse on every /api/config call. */
function readForceTrack(): boolean {
  const envPath = path.join(SCRIPTS_DIR, '.env');
  if (!fs.existsSync(envPath)) return false;
  const content = fs.readFileSync(envPath, 'utf8');
  const match = content.match(FORCE_TRACK_RE);
  return !!(match?.[1] && match[1].toLowerCase() === 'true');
}

/**
 * Pick the right autoload extension for the current runtime. In dev (`tsx`)
 * we have only `.ts` files; the production bundle (tsup) has only `.js`.
 * Loading both would double-register every route plugin.
 */
function autoloadExtension(): '.ts' | '.js' {
  return import.meta.url.endsWith('.ts') ? '.ts' : '.js';
}

async function main(): Promise<void> {
  const app = Fastify({
    logger: true,
    // Default Fastify limit is 1 MiB. /api/import can carry the full hub
    // export (bookmarks + schedules + webhooks + env profiles), which can
    // exceed 1 MiB in larger workspaces.
    bodyLimit: 5 * 1024 * 1024,
  });

  // Enable zod-based request validation for routes that declare a `schema`
  // (body/params/querystring). Only the validator is registered — response
  // serialization stays on Fastify's default, so schemaless routes are
  // unaffected. Routes opt in by attaching a zod schema.
  app.setValidatorCompiler(validatorCompiler);

  // Plugins
  //
  // CORS is locked to the known client origins (config.ALLOWED_ORIGINS) rather
  // than reflecting any origin. The Hub binds loopback and runs `task`/git/
  // credential commands, so an unrestricted CORS policy would let any page in
  // the same browser drive it (CSRF→RCE). Requests with no Origin header
  // (curl, same-origin navigation) are still allowed.
  await app.register(cors, {
    origin(origin, cb) {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error('Origin not allowed'), false);
    },
  });
  await app.register(websocket);

  // DNS-rebinding guard. The Hub is reachable only on loopback, so a legitimate
  // request's Host header must resolve to localhost. Rejecting anything else
  // blocks an attacker domain that rebinds its DNS to 127.0.0.1 to reach these
  // command-executing routes from a victim's browser.
  app.addHook('onRequest', async (req, reply) => {
    const raw = (req.headers.host ?? '').toLowerCase();
    const hostname = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0];
    if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
      return reply.code(403).send({ code: 'FORBIDDEN_HOST', message: 'Unexpected Host header' });
    }
  });

  // Open the embedded Local_DB before any route/service registers. `getDb()`
  // prepares the SQLite schema and runs the legacy blob→normalized upgrade
  // inside `openLocalDb`, so services that load state at construction time
  // (scheduler, webhooks, env-profiles, …) read a fully-prepared database.
  getDb();

  // After-run steps: map each finished run's results onto its project's
  // test-case docs, then drop the report when the run asked for that. Wired here
  // (not lazily from a route) so a run started before anyone opens the Test Cases
  // page still has its results recorded.
  startPostRunPipeline();

  const interrupted = historyStore.reconcileInterrupted();
  if (interrupted.length > 0) {
    app.log.warn(
      `[boot] ${interrupted.length} run(s) were in flight when the Hub last stopped — marked as error: ${interrupted
        .map((r) => `${r.request.tool}/${r.request.project}`)
        .join(', ')}`,
    );
  }

  /**
   * Auto-load every route file under `src/routes/`. Each file exports a
   * Fastify plugin as default. Adding a new route is now zero-touch — just
   * drop a new file in routes/ with `export default async function (app) {...}`.
   * The runtime picks the right extension so we never double-register.
   */
  const ext = autoloadExtension();
  await app.register(autoload, {
    dir: ROUTES_DIR,
    // Load real route files only. Skip co-located tests (`*.test.*`, `*.spec.*`)
    // and anything under a `__tests__/` folder so autoload never tries to
    // register a test as a route plugin (which would throw on its imports).
    matchFilter: (filename) =>
      filename.endsWith(ext) &&
      !filename.includes('__tests__') &&
      !/\.(test|spec)\.[cm]?[jt]s$/.test(filename),
    forceESM: true,
  });

  // Health check + non-secret config — kept inline because they read from
  // multiple bootstrap-time singletons (config + docker probe).
  app.get('/api/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  app.get('/api/config', async () => {
    const dockerRunning = await isDockerRunning();
    return { forceTrack: readForceTrack(), dockerRunning };
  });

  /**
   * Centralized error handler. Without this Fastify leaks the raw error
   * `.message` (which can contain stack traces in dev) and a 500 with no
   * machine-readable code. The structured response matches the rest of our
   * routes (`{ code, message }`).
   *
   * Fastify ships `FastifyError` with `statusCode`/`code` typed; we still
   * defensively narrow because user routes can throw generic Errors.
   */
  app.setErrorHandler((err, req, reply) => {
    const fastifyErr = err as Error & { statusCode?: number; code?: string };
    const status =
      fastifyErr.statusCode && fastifyErr.statusCode >= 400 ? fastifyErr.statusCode : 500;
    req.log.error({ err, url: req.url, method: req.method }, 'Request failed');
    reply.status(status).send({
      code: fastifyErr.code ?? (status === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR'),
      message:
        process.env.NODE_ENV === 'production' && status === 500
          ? 'Internal server error'
          : fastifyErr.message || 'Unknown error',
    });
  });

  // Serve client static bundle in production
  if (fs.existsSync(CLIENT_DIST_DIR)) {
    await app.register(fastifyStatic, {
      root: CLIENT_DIST_DIR,
      prefix: '/',
      wildcard: false,
      // Hashed assets (/assets/*) are immutable — cache aggressively.
      // index.html and other root files must not be cached.
      //
      // @fastify/static v10 passes the Fastify `reply` (not the raw Node
      // `res`) to setHeaders, so headers are set via reply.header(), not
      // res.setHeader() — the v9→v10 signature change that this callback
      // must track.
      setHeaders(reply, filePath) {
        if (filePath.includes('assets')) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
      },
    });

    // SPA fallback — serve index.html for non-API routes.
    // Skip /assets/ paths: if a hashed chunk is missing after a rebuild,
    // return a proper 404 so the browser can detect the stale module and
    // trigger a reload instead of receiving HTML with wrong MIME type.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/assets/')) {
        reply.status(404);
        return { error: 'Asset not found' };
      }
      reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      return reply.sendFile('index.html', CLIENT_DIST_DIR);
    });

    app.log.info(`Serving client from ${CLIENT_DIST_DIR}`);
  }

  // Surface async crashes to the structured logger instead of the default
  // Node stderr dump. An OS supervisor (systemd/launchd) restarts the Hub after
  // the exit-on-uncaughtException below; we just want the root cause to appear
  // in the same log stream.
  process.on('unhandledRejection', (reason) => {
    app.log.error({ reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, 'Uncaught exception — process will exit');
    process.exit(1);
  });

  // Graceful shutdown — systemd/launchd send SIGTERM; Ctrl+C in dev sends SIGINT.
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`Received ${signal}, shutting down gracefully...`);
    try {
      await app.close();
    } catch (err) {
      app.log.error({ err }, 'Error closing fastify');
    }
    for (const r of runner.getActive()) runner.cancel(r.id);
    try {
      await appiumServer.stop();
    } catch (err) {
      app.log.error({ err }, 'Error stopping appium');
    }
    try {
      await killAllTraceProcesses();
    } catch (err) {
      app.log.error({ err }, 'Error stopping trace viewers');
    }
    try {
      await historyStore.flush();
    } catch (err) {
      app.log.error({ err }, 'Error flushing history');
    }
    try {
      await flushPersistence();
    } catch (err) {
      app.log.error({ err }, 'Error flushing persistence');
    }
    process.exit(0);
  }
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  // Start
  await app.listen({ host: HOST, port: PORT });
  app.log.info(`Hub server running at http://${HOST}:${PORT}`);
}

main().catch((err) => {
  console.error('Failed to start Hub server:', err);
  process.exit(1);
});
