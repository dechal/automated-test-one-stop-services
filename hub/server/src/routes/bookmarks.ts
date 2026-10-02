import {
  type Bookmark,
  type BookmarkWithStatus,
  buildTagQuery,
  parseTagQuery,
  type RunRequest,
  type ToolId,
} from '@hub/shared';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { mapPool } from '../lib/map-pool.js';
import { getEnabledToolIds } from '../services/manifest-registry.js';
import { loadJson, saveJson } from '../services/persistence.js';
import { type ProjectTagsResult, resolveProjectTags } from '../services/project-tags.js';

const BOOKMARKS_FILE = 'bookmarks.json';

/** Compare tags ignoring a single leading `@` — Robot authors omit it inconsistently. */
function tagKey(tag: string): string {
  return tag.startsWith('@') ? tag.slice(1) : tag;
}

/**
 * Tags referenced in `expr` that the project no longer emits. Tool-aware: the
 * splitter dispatches on `tool` so a Robot `AND`/`OR`/`NOT` pattern is parsed by
 * the Robot path, not mistaken for one bogus Playwright tag. Both include and
 * exclude tags are checked — an exclude naming a vanished tag is stale clutter.
 */
export function computeStaleTags(
  tool: ToolId,
  expr: string | undefined,
  projectTags: Set<string>,
): string[] {
  const { include, exclude } = parseTagQuery(tool, expr);
  const present = new Set([...projectTags].map(tagKey));
  const referenced = [...new Set([...include, ...exclude])];
  return referenced.filter((tag) => !present.has(tagKey(tag)));
}

function getBookmarks(): Bookmark[] {
  return loadJson<Bookmark[]>(BOOKMARKS_FILE, []);
}

function setBookmarks(bookmarks: Bookmark[]): void {
  saveJson(BOOKMARKS_FILE, bookmarks);
}

/**
 * Body accepted by `POST /api/bookmarks` — a name plus the run-form config to
 * capture. A bookmark is a plain macro: name + config, nothing else.
 */
interface CreateBookmarkBody {
  name: string;
  config: RunRequest;
}

/**
 * Body accepted by `PUT /api/bookmarks/:id` — a partial update. Either field
 * may be omitted: send `{ name }` to rename, `{ config }` to overwrite the
 * captured run-form config (e.g. after tweaking the form), or both at once.
 */
interface UpdateBookmarkBody {
  name?: string;
  config?: RunRequest;
}

export async function bookmarkRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/bookmarks — list saved configs for ENABLED tools only, each
   *  annotated with its stale tags (tags no longer in the target project). The
   *  tag scan is batched per distinct tool|type|project and bounded to 4 in
   *  flight; one group's scan failure marks only its bookmarks `scanFailed`,
   *  never the whole list. */
  app.get('/api/bookmarks', async (_req, reply) => {
    try {
      const enabledIds = await getEnabledToolIds();
      const bookmarks = getBookmarks().filter((b) => enabledIds.has(b.config.tool));

      const groupKey = (c: RunRequest) => `${c.tool}|${c.type}|${c.project}`;
      const keys = [...new Set(bookmarks.map((b) => groupKey(b.config)))];
      const scans = await mapPool(keys, 4, async (key) => {
        const [tool, type, project] = key.split('|') as [ToolId, string, string];
        const result = await resolveProjectTags(tool, type, project);
        if (!result.ok) app.log.warn({ tool, type, project }, 'bookmark tag scan failed');
        return [key, result] as const;
      });
      const byKey = new Map<string, ProjectTagsResult>(scans);

      return bookmarks.map((bm): BookmarkWithStatus => {
        const result = byKey.get(groupKey(bm.config));
        if (!result || !result.ok) return { ...bm, staleTags: [], scanFailed: true };
        return {
          ...bm,
          staleTags: computeStaleTags(bm.config.tool, bm.config.tag, result.tags),
          scanFailed: false,
        };
      });
    } catch (err) {
      app.log.error(err, 'failed to annotate bookmarks');
      reply.status(500);
      const e = err as { message?: string };
      return { code: 'BOOKMARK_STATUS_FAILED', message: e.message ?? String(err) };
    }
  });

  /** POST /api/bookmarks/:id/migrate — strip the stale tags from this
   *  bookmark's `config.tag`, keeping everything else. No `Body` is accepted, so
   *  a client cannot smuggle any other field edit through this endpoint. */
  app.post<{ Params: { id: string } }>('/api/bookmarks/:id/migrate', async (req, reply) => {
    const bookmarks = getBookmarks();
    const idx = bookmarks.findIndex((b) => b.id === req.params.id);
    if (idx === -1) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'Bookmark not found' };
    }

    const existing = bookmarks[idx] as Bookmark;
    const { tool, type, project } = existing.config;
    const result = await resolveProjectTags(tool, type, project);
    if (!result.ok) {
      app.log.warn({ tool, type, project }, 'bookmark migrate scan failed');
      reply.status(503);
      return { code: 'TAG_SCAN_FAILED', message: 'Could not scan the project tags' };
    }

    const stale = computeStaleTags(tool, existing.config.tag, result.tags);
    if (stale.length === 0) {
      // Already healthy — idempotent no-op (a concurrent migrate or a project
      // that regained its tags must not 500).
      const healthy: BookmarkWithStatus = { ...existing, staleTags: [], scanFailed: false };
      return healthy;
    }

    const staleKeys = new Set(stale.map(tagKey));
    const { include, exclude } = parseTagQuery(tool, existing.config.tag);
    const remainingInclude = include.filter((tag) => !staleKeys.has(tagKey(tag)));
    const remainingExclude = exclude.filter((tag) => !staleKeys.has(tagKey(tag)));
    const tag = buildTagQuery(tool, remainingInclude, remainingExclude);

    const updated: Bookmark = { ...existing, config: { ...existing.config, tag } };
    bookmarks[idx] = updated;
    setBookmarks(bookmarks);

    const migrated: BookmarkWithStatus = { ...updated, staleTags: [], scanFailed: false };
    return migrated;
  });

  /** POST /api/bookmarks — save a new config */
  app.post<{ Body: CreateBookmarkBody }>('/api/bookmarks', async (req) => {
    const bookmarks = getBookmarks();
    const { name, config } = req.body;

    const bookmark: Bookmark = {
      id: nanoid(8),
      name,
      config,
      createdAt: new Date().toISOString(),
    };

    bookmarks.unshift(bookmark);
    setBookmarks(bookmarks);
    return bookmark;
  });

  /** PUT /api/bookmarks/:id — rename and/or overwrite the captured config.
   *  Partial: only the provided fields change; `createdAt`/`id` are preserved. */
  app.put<{ Params: { id: string }; Body: UpdateBookmarkBody }>(
    '/api/bookmarks/:id',
    async (req, reply) => {
      const bookmarks = getBookmarks();
      const idx = bookmarks.findIndex((b) => b.id === req.params.id);
      if (idx === -1) {
        reply.status(404);
        return { code: 'NOT_FOUND', message: 'Bookmark not found' };
      }

      const existing = bookmarks[idx] as Bookmark;
      const { name, config } = req.body;
      const trimmed = name?.trim();
      const updated: Bookmark = {
        ...existing,
        ...(trimmed ? { name: trimmed } : {}),
        ...(config ? { config } : {}),
      };
      bookmarks[idx] = updated;
      setBookmarks(bookmarks);
      return updated;
    },
  );

  /** DELETE /api/bookmarks/:id — remove a saved config */
  app.delete<{ Params: { id: string } }>('/api/bookmarks/:id', async (req, reply) => {
    const bookmarks = getBookmarks();
    const idx = bookmarks.findIndex((b) => b.id === req.params.id);
    if (idx === -1) {
      reply.status(404);
      return { code: 'NOT_FOUND', message: 'Bookmark not found' };
    }
    bookmarks.splice(idx, 1);
    setBookmarks(bookmarks);
    return { success: true };
  });
}

export default bookmarkRoutes;
