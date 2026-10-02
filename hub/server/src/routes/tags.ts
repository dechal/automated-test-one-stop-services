import {
  buildTagGroups,
  classifyTag,
  type TagDetail,
  type TagsResponse,
  type TestSummary,
  type ToolId,
} from '@hub/shared';
import type { FastifyInstance } from 'fastify';
import { resolveProjectTags } from '../services/project-tags.js';

// ---------------------------------------------------------------------------
// Classification is owned ENTIRELY by `@hub/shared` (`classifyTag` /
// `buildTagGroups`). This route never re-implements category rules — it only
// gathers raw test data (via `resolveProjectTags`, which parses the reporter
// sentinel block or a legacy fallback) and hands it to the shared taxonomy.
// That single source of truth is why the Hub UI is always internally
// consistent.
// ---------------------------------------------------------------------------

interface ReporterPayload {
  tool?: ToolId;
  tests?: TestSummary[];
}

// ---------------------------------------------------------------------------
// Tag deduplication — merge tags that cover the EXACT same set of tests within
// the same category (true aliases, e.g. `@ta` and `@ta-main` always co-occur).
// Cross-category tags are never merged. This only collapses visual noise; it
// does not reclassify anything.
// ---------------------------------------------------------------------------

/** Canonical preference: a case-id wins, otherwise the shortest/alphabetically-first. */
function canonicalTag(tags: string[]): string {
  const caseIds = tags.filter((t) => classifyTag(t) === 'case-id');
  const pool = caseIds.length > 0 ? caseIds : tags;
  return [...pool].sort((a, b) => a.length - b.length || a.localeCompare(b))[0] ?? tags[0] ?? '';
}

function dedupeAliases(tests: TestSummary[]): TestSummary[] {
  if (tests.length === 0) return tests;

  // Signature = sorted ids of the tests a tag appears on.
  const idsByTag = new Map<string, string[]>();
  for (const t of tests) {
    const id = t.id || t.title;
    for (const tag of t.tags) {
      const list = idsByTag.get(tag);
      if (list) list.push(id);
      else idsByTag.set(tag, [id]);
    }
  }

  // Bucket tags by (kind + signature); a bucket with >1 tag = aliases.
  const buckets = new Map<string, string[]>();
  for (const [tag, ids] of idsByTag) {
    const key = `${classifyTag(tag)}\u0001${[...ids].sort().join('\u0001')}`;
    const list = buckets.get(key);
    if (list) list.push(tag);
    else buckets.set(key, [tag]);
  }

  const aliasMap = new Map<string, string>();
  for (const group of buckets.values()) {
    if (group.length <= 1) continue;
    const canonical = canonicalTag(group);
    for (const tag of group) if (tag !== canonical) aliasMap.set(tag, canonical);
  }
  if (aliasMap.size === 0) return tests;

  return tests.map((t) => ({
    ...t,
    tags: [...new Set(t.tags.map((tag) => aliasMap.get(tag) ?? tag))],
  }));
}

/** Project the per-test tag lists into a tag-first detail map (for tooltips). */
function buildDetails(tests: TestSummary[]): Record<string, TagDetail> {
  const details: Record<string, TagDetail> = {};
  for (const t of tests) {
    const child = { tag: t.id ? `@${t.id}` : '', title: t.title };
    for (const tag of t.tags) {
      const existing = details[tag];
      if (existing) {
        existing.count += 1;
        existing.tests.push(child);
      } else {
        details[tag] = { tag, count: 1, tests: [child] };
      }
    }
  }
  return details;
}

function buildResponse(
  tool: ToolId,
  type: string,
  project: string,
  payload: ReporterPayload | null,
  fallbackTags: string[],
): TagsResponse {
  // Primary path: the reporter gave us raw per-test tag lists. Dedupe aliases,
  // project to a detail map, then classify + order via the shared taxonomy.
  if (payload?.tests && payload.tests.length > 0) {
    const tests = dedupeAliases(payload.tests);
    const details = buildDetails(tests);
    const all = Object.keys(details).sort();
    const groups = buildTagGroups(all, (tag) => details[tag]?.count ?? 0);
    return { tool, type, project, groups, all, details, tests };
  }

  // Fallback path: a flat tag list only (no per-test data).
  const all = [...new Set(fallbackTags)].sort();
  return { tool, type, project, groups: buildTagGroups(all), all, details: {}, tests: [] };
}

export async function tagRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/tags?tool=playwright|robot-framework&type=web&project=example */
  app.get<{ Querystring: { tool: ToolId; type: string; project: string } }>(
    '/api/tags',
    async (req) => {
      const { tool, type, project } = req.query;
      const result = await resolveProjectTags(tool, type, project);

      // A failed/empty scan maps to the SAME empty response an empty scan
      // produced before this refactor — only the bookmark callers act on the
      // `ok: false` signal, so `/api/tags` behaviour is unchanged.
      if (!result.ok) return buildResponse(tool, type, project, null, []);

      // The sentinel path carries per-test data (`tests`); the fallback paths
      // carry only a flat tag set. Reconstruct the inputs `buildResponse` wants.
      const payload = result.tests ? { tool, tests: result.tests } : null;
      const fallbackTags = result.tests ? [] : [...result.tags];
      return buildResponse(tool, type, project, payload, fallbackTags);
    },
  );
}

export default tagRoutes;
