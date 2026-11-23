import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  addRemote,
  deleteRemote,
  findRepo,
  loadRepos,
  publicRepos,
  type RemoteResult,
  setUrl,
  validateRemoteName,
  validateRemoteUrl,
} from '../services/git-remotes.js';

interface RemoteBody {
  repo?: unknown;
  name?: unknown;
  url?: unknown;
  confirmUrl?: unknown;
}

function badRequest(reply: FastifyReply, message: string) {
  reply.status(400);
  return { code: 'BAD_REQUEST', message };
}

function respond(reply: FastifyReply, result: RemoteResult) {
  if (result.ok) return { ok: true };
  reply.status(result.status);
  return { code: result.code, message: result.message };
}

export async function remotesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/remotes', async (_req, reply) => {
    const repos = await loadRepos();
    if (!repos) {
      reply.status(500);
      return { code: 'REMOTES_FAILED', message: 'Could not list repositories' };
    }
    return { repos: publicRepos(repos) };
  });

  app.post<{ Body: RemoteBody | undefined }>('/api/remotes/set-url', async (req, reply) => {
    const { repo, name, url } = req.body ?? {};
    if (!validateRemoteName(name)) return badRequest(reply, 'Invalid remote name');
    if (!validateRemoteUrl(url)) return badRequest(reply, 'Invalid remote URL');
    const found = await findRepo(repo);
    if (!('dir' in found)) return respond(reply, found);
    return respond(reply, await setUrl(found.dir, name, url));
  });

  app.post<{ Body: RemoteBody | undefined }>('/api/remotes/add', async (req, reply) => {
    const { repo, name, url } = req.body ?? {};
    if (!validateRemoteName(name)) return badRequest(reply, 'Invalid remote name');
    if (!validateRemoteUrl(url)) return badRequest(reply, 'Invalid remote URL');
    const found = await findRepo(repo);
    if (!('dir' in found)) return respond(reply, found);
    return respond(reply, await addRemote(found.dir, name, url));
  });

  app.post<{ Body: RemoteBody | undefined }>('/api/remotes/delete', async (req, reply) => {
    const { repo, name, confirmUrl } = req.body ?? {};
    if (!validateRemoteName(name)) return badRequest(reply, 'Invalid remote name');
    if (typeof confirmUrl !== 'string') return badRequest(reply, 'Confirmation URL required');
    const found = await findRepo(repo);
    if (!('dir' in found)) return respond(reply, found);
    return respond(reply, await deleteRemote(found.dir, name, confirmUrl));
  });
}

export default remotesRoutes;
