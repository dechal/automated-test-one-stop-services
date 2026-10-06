import type { EnvProfile } from '@hub/shared';
import { setDb } from '@server/services/db.js';
import { envProfileService } from '@server/services/env-profiles.js';
import { openLocalDb } from '@server/services/local-db.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import envProfileRoutes from '../env-profiles.js';
import scheduleRoutes from '../schedules.js';

// Schedule GET filters on getEnabledToolIds(), which scans the git-ignored tool
// repos (absent in CI). These tests exercise create/update persistence, so
// treat playwright as enabled.
vi.mock('@server/services/manifest-registry.js', () => ({
  getEnabledToolIds: async () => new Set(['playwright']),
}));

/**
 * Route tests for the FEAT-001 server surface, driven through app.inject on a
 * fresh in-memory Local_DB per test:
 *   - the 3 new env-profile routes (default, GET default, validate)
 *   - apply rejects extraKeys with the switch off → 400 + the list
 *   - schedule create / update carrying envProfileId round-trips
 *
 * `getTemplate` reads the real filesystem, so it is spied to a controlled map.
 */

const base = {
  environment: 'dev',
  tool: 'playwright' as const,
  type: 'web',
  project: 'demo',
};

function makeProfileBody(
  over: Partial<EnvProfile> = {},
): Omit<EnvProfile, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: 'profile',
    ...base,
    entries: { A: '1' },
    ...over,
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(envProfileRoutes);
  await app.register(scheduleRoutes);
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  setDb(openLocalDb(':memory:'));
  vi.spyOn(envProfileService, 'getTemplate').mockReturnValue({ A: '' });
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  setDb(undefined);
});

describe('POST /api/env-profiles/:id/default', () => {
  it('sets the profile as default and clears siblings', async () => {
    const first = envProfileService.create(makeProfileBody({ name: 'first' }));
    const second = envProfileService.create(makeProfileBody({ name: 'second' }));
    envProfileService.setDefault(first.id);

    const res = await app.inject({
      method: 'POST',
      url: `/api/env-profiles/${second.id}/default`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<EnvProfile>().isDefault).toBe(true);

    const defaultId = envProfileService.getDefault(base.tool, base.type, base.project);
    expect(defaultId).toBe(second.id);
  });

  it('404 on an unknown id', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/env-profiles/nope/default' });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('NOT_FOUND');
  });
});

describe('GET /api/env-profiles/default', () => {
  it('returns the default id for a (tool,type,project)', async () => {
    const profile = envProfileService.create(makeProfileBody());
    envProfileService.setDefault(profile.id);
    const res = await app.inject({
      method: 'GET',
      url: '/api/env-profiles/default?tool=playwright&type=web&project=demo',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ defaultId: string | null }>().defaultId).toBe(profile.id);
  });

  it('returns null when none is marked default', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/env-profiles/default?tool=playwright&type=web&project=none',
    });
    expect(res.json<{ defaultId: string | null }>().defaultId).toBeNull();
  });
});

describe('GET /api/env-profiles/validate', () => {
  it('returns the validation shape for an existing profile', async () => {
    const profile = envProfileService.create(makeProfileBody({ entries: { A: '1', EXTRA: '2' } }));
    const res = await app.inject({
      method: 'GET',
      url: `/api/env-profiles/validate?id=${profile.id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ extraKeys: string[]; missingKeys: string[]; hasTemplate: boolean }>();
    expect(body.hasTemplate).toBe(true);
    expect(body.extraKeys).toEqual(['EXTRA']);
    expect(body.missingKeys).toEqual([]);
  });

  it('404 on an unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/env-profiles/validate?id=nope' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/env-profiles/:id/apply — template gate', () => {
  it('rejects extraKeys with the switch off → 400 + extraKeys', async () => {
    const profile = envProfileService.create(
      makeProfileBody({ entries: { A: '1', EXTRA: '2' }, allowOutsideTemplate: false }),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/env-profiles/${profile.id}/apply`,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ code: string; extraKeys: string[] }>();
    expect(body.code).toBe('OUTSIDE_TEMPLATE_KEYS');
    expect(body.extraKeys).toEqual(['EXTRA']);
  });
});

describe('POST /api/env-profiles — create gate', () => {
  it('blocks a create carrying extraKeys with the switch off', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/env-profiles',
      payload: makeProfileBody({ entries: { A: '1', EXTRA: '2' } }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('OUTSIDE_TEMPLATE_KEYS');
  });

  it('allows a create carrying extraKeys when the switch is on', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/env-profiles',
      payload: makeProfileBody({ entries: { A: '1', EXTRA: '2' }, allowOutsideTemplate: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<EnvProfile>().allowOutsideTemplate).toBe(true);
  });
});

describe('schedule envProfileId round-trip', () => {
  const config = { tool: 'playwright', type: 'web', project: 'demo', mode: 'local' } as const;

  it('create persists envProfileId and read-back carries it', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/schedules',
      payload: { name: 'nightly', cron: '0 0 * * *', config, envProfileId: 'prof-xyz' },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json<{ id: string }>().id;

    const list = await app.inject({ method: 'GET', url: '/api/schedules' });
    const stored = list
      .json<Array<{ id: string; envProfileId?: string }>>()
      .find((s) => s.id === id);
    expect(stored?.envProfileId).toBe('prof-xyz');
  });

  it('does not store the __current__ sentinel', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/schedules',
      payload: { name: 'cur', cron: '0 0 * * *', config, envProfileId: '__current__' },
    });
    const id = created.json<{ id: string }>().id;
    const list = await app.inject({ method: 'GET', url: '/api/schedules' });
    const stored = list
      .json<Array<{ id: string; envProfileId?: string }>>()
      .find((s) => s.id === id);
    expect(stored?.envProfileId).toBeUndefined();
  });

  it('update carries envProfileId through to the stored schedule', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/schedules',
      payload: { name: 'edit-me', cron: '0 0 * * *', config },
    });
    const id = created.json<{ id: string }>().id;

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/schedules/${id}`,
      payload: { envProfileId: 'prof-updated' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ envProfileId?: string }>().envProfileId).toBe('prof-updated');

    const list = await app.inject({ method: 'GET', url: '/api/schedules' });
    const stored = list
      .json<Array<{ id: string; envProfileId?: string }>>()
      .find((s) => s.id === id);
    expect(stored?.envProfileId).toBe('prof-updated');
  });
});
