import type { Bookmark, RunRequest } from '@hub/shared';
import { setDb } from '@server/services/db.js';
import { openLocalDb } from '@server/services/local-db.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bookmarkRoutes from '../bookmarks.js';

// The GET route hides bookmarks of disabled/uninstalled tools by filtering on
// getEnabledToolIds(), which scans the (git-ignored, CI-absent) tool repos.
// These tests exercise bookmark CRUD, not tool provisioning, so treat every
// tool as enabled — otherwise the list is empty wherever tools/ is not present.
vi.mock('@server/services/manifest-registry.js', () => ({
  getEnabledToolIds: async () => new Set(['playwright']),
}));

// The annotate + migrate paths scan a project's real tags via resolveProjectTags
// (which shells out). Mock it so HTTP + persistence + error-mapping is tested
// without a child process; `mockResolveProjectTags` is set per test.
import type { ProjectTagsResult } from '@server/services/project-tags.js';

const mockResolveProjectTags = vi.fn<() => Promise<ProjectTagsResult>>();
vi.mock('@server/services/project-tags.js', () => ({
  resolveProjectTags: () => mockResolveProjectTags(),
}));

/**
 * Bookmark route tests: a bookmark is a plain macro — `{ id, name, config,
 * createdAt }`. No promoted fields, no usage tracking.
 *
 * Uses a real Fastify instance + a fresh in-memory Local_DB per test (so the
 * bookmarks table is exercised end to end), driven through `app.inject` — no
 * network, no mocks.
 */

const baseConfig: RunRequest = {
  tool: 'playwright',
  type: 'web',
  project: 'demo',
  mode: 'local',
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(bookmarkRoutes);
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  setDb(openLocalDb(':memory:'));
  // Default: scan succeeds and the project emits exactly the tags used below, so
  // untouched CRUD tests see healthy bookmarks (staleTags: []).
  mockResolveProjectTags.mockResolvedValue({
    ok: true,
    tags: new Set(['@smoke', '@t', '@regression']),
  });
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  setDb(undefined);
});

describe('POST /api/bookmarks — create', () => {
  it('stores name + config and returns { id, name, config, createdAt } only', async () => {
    const config: RunRequest = {
      ...baseConfig,
      tag: '@smoke',
      extraArgs: '--workers=2',
      silent: true,
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/bookmarks',
      payload: { name: 'from-config', config },
    });
    expect(res.statusCode).toBe(200);
    const bm = res.json<Bookmark>();
    expect(bm.name).toBe('from-config');
    expect(typeof bm.id).toBe('string');
    expect(typeof bm.createdAt).toBe('string');
    // The config round-trips intact (the macro captures the run form verbatim).
    expect(bm.config).toEqual(config);
    // No promoted fields are added to the bookmark.
    expect(Object.keys(bm).sort()).toEqual(['config', 'createdAt', 'id', 'name']);
  });
});

describe('GET /api/bookmarks — list + persistence round-trip', () => {
  it('lists created bookmarks newest-first and round-trips the config', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/bookmarks',
      payload: { name: 'first', config: baseConfig },
    });
    await app.inject({
      method: 'POST',
      url: '/api/bookmarks',
      payload: { name: 'second', config: { ...baseConfig, tag: '@t', project: 'other' } },
    });

    const list = (await app.inject({ method: 'GET', url: '/api/bookmarks' })).json<Bookmark[]>();
    expect(list).toHaveLength(2);
    // unshift → newest first.
    expect(list[0]?.name).toBe('second');
    expect(list[0]?.config.tag).toBe('@t');
    expect(list[0]?.config.project).toBe('other');
    expect(list[1]?.name).toBe('first');
    expect(list[1]?.config.project).toBe('demo');
  });
});

describe('PUT /api/bookmarks/:id — edit', () => {
  it('renames a bookmark while preserving id/createdAt/config', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/bookmarks',
        payload: { name: 'old-name', config: baseConfig },
      })
    ).json<Bookmark>();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/bookmarks/${created.id}`,
      payload: { name: 'new-name' },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json<Bookmark>();
    expect(updated.name).toBe('new-name');
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.config).toEqual(baseConfig);
  });

  it('overwrites the captured config without changing the name', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/bookmarks',
        payload: { name: 'keep-name', config: baseConfig },
      })
    ).json<Bookmark>();

    const newConfig: RunRequest = { ...baseConfig, project: 'updated', tag: '@regression' };
    const updated = (
      await app.inject({
        method: 'PUT',
        url: `/api/bookmarks/${created.id}`,
        payload: { config: newConfig },
      })
    ).json<Bookmark>();
    expect(updated.name).toBe('keep-name');
    expect(updated.config).toEqual(newConfig);
  });

  it('returns 404 for an unknown bookmark id', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/bookmarks/does-not-exist',
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/bookmarks/:id', () => {
  it('removes a bookmark and returns success', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/bookmarks',
        payload: { name: 'doomed', config: baseConfig },
      })
    ).json<Bookmark>();

    const del = await app.inject({ method: 'DELETE', url: `/api/bookmarks/${created.id}` });
    expect(del.statusCode).toBe(200);
    expect(del.json<{ success: boolean }>().success).toBe(true);

    const list = (await app.inject({ method: 'GET', url: '/api/bookmarks' })).json<Bookmark[]>();
    expect(list).toHaveLength(0);
  });

  it('returns 404 for an unknown bookmark id', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/bookmarks/does-not-exist' });
    expect(res.statusCode).toBe(404);
  });
});

async function createBookmark(name: string, config: RunRequest): Promise<Bookmark> {
  return (
    await app.inject({ method: 'POST', url: '/api/bookmarks', payload: { name, config } })
  ).json<Bookmark>();
}

interface StatusBookmark extends Bookmark {
  staleTags: string[];
  scanFailed: boolean;
}

describe('GET /api/bookmarks — stale-tag annotation', () => {
  it('marks a bookmark stale when its tag is absent from the project', async () => {
    mockResolveProjectTags.mockResolvedValue({ ok: true, tags: new Set(['@critical']) });
    await createBookmark('stale', { ...baseConfig, tag: '(?=.*@gone)' });

    const list = (await app.inject({ method: 'GET', url: '/api/bookmarks' })).json<
      StatusBookmark[]
    >();
    expect(list[0]?.staleTags).toEqual(['@gone']);
    expect(list[0]?.scanFailed).toBe(false);
  });

  it('leaves a healthy bookmark with no stale tags', async () => {
    mockResolveProjectTags.mockResolvedValue({ ok: true, tags: new Set(['@smoke']) });
    await createBookmark('healthy', { ...baseConfig, tag: '(?=.*@smoke)' });

    const list = (await app.inject({ method: 'GET', url: '/api/bookmarks' })).json<
      StatusBookmark[]
    >();
    expect(list[0]?.staleTags).toEqual([]);
    expect(list[0]?.scanFailed).toBe(false);
  });

  it('sets scanFailed with empty staleTags when the scan fails', async () => {
    mockResolveProjectTags.mockResolvedValue({ ok: false });
    await createBookmark('unknown', { ...baseConfig, tag: '(?=.*@smoke)' });

    const list = (await app.inject({ method: 'GET', url: '/api/bookmarks' })).json<
      StatusBookmark[]
    >();
    expect(list[0]?.scanFailed).toBe(true);
    expect(list[0]?.staleTags).toEqual([]);
  });
});

describe('POST /api/bookmarks/:id/migrate', () => {
  it('strips stale tags and persists only config.tag', async () => {
    mockResolveProjectTags.mockResolvedValue({ ok: true, tags: new Set(['@keep']) });
    const created = await createBookmark('to-migrate', {
      ...baseConfig,
      tag: '(?=.*@keep)(?=.*@gone)',
      extraArgs: '--workers=2',
      silent: true,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/bookmarks/${created.id}/migrate`,
    });
    expect(res.statusCode).toBe(200);
    const migrated = res.json<StatusBookmark>();
    expect(migrated.staleTags).toEqual([]);
    expect(migrated.config.tag).toBe('(?=.*@keep)');
    // Only config.tag changed — everything else is intact.
    expect(migrated.id).toBe(created.id);
    expect(migrated.name).toBe(created.name);
    expect(migrated.createdAt).toBe(created.createdAt);
    expect(migrated.config.extraArgs).toBe('--workers=2');
    expect(migrated.config.silent).toBe(true);

    // Re-GET confirms the edit was persisted.
    const list = (await app.inject({ method: 'GET', url: '/api/bookmarks' })).json<
      StatusBookmark[]
    >();
    expect(list[0]?.config.tag).toBe('(?=.*@keep)');
  });

  it('is a 200 no-op on an already-healthy bookmark', async () => {
    mockResolveProjectTags.mockResolvedValue({ ok: true, tags: new Set(['@smoke']) });
    const created = await createBookmark('healthy', { ...baseConfig, tag: '(?=.*@smoke)' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/bookmarks/${created.id}/migrate`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<StatusBookmark>().config.tag).toBe('(?=.*@smoke)');
  });

  it('returns 503 and does not change the file when the scan fails', async () => {
    mockResolveProjectTags.mockResolvedValue({ ok: true, tags: new Set(['@keep']) });
    const created = await createBookmark('scan-fail', { ...baseConfig, tag: '(?=.*@keep)' });

    mockResolveProjectTags.mockResolvedValue({ ok: false });
    const res = await app.inject({
      method: 'POST',
      url: `/api/bookmarks/${created.id}/migrate`,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ code: string }>().code).toBe('TAG_SCAN_FAILED');

    // The stored config.tag is untouched.
    mockResolveProjectTags.mockResolvedValue({ ok: true, tags: new Set(['@keep']) });
    const list = (await app.inject({ method: 'GET', url: '/api/bookmarks' })).json<
      StatusBookmark[]
    >();
    expect(list[0]?.config.tag).toBe('(?=.*@keep)');
  });

  it('returns 404 for an unknown bookmark id', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/bookmarks/nope/migrate' });
    expect(res.statusCode).toBe(404);
  });
});
