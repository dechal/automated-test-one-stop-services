import fs from 'node:fs';
import path from 'node:path';
import type { TestSummary, ToolId } from '@hub/shared';
import { BASH_PATH, TOOLS_DIR, WORKSPACE_ROOT } from '../config.js';
import { buildPlaywrightListCommand, buildTagsCommand } from './command-builder.js';
import { runChild } from './exec.js';
import { getToolCapabilities, getToolManifest } from './manifest-registry.js';
import { listAllProjects } from './scanner.js';

interface ReporterPayload {
  tool?: ToolId;
  tests?: TestSummary[];
}

/**
 * Result of resolving a project's current real tag set.
 *
 * `ok: false` is NOT the same as "empty project": a scan that errored, timed
 * out, or produced nothing parseable returns `ok: false` so callers can tell a
 * failed scan from a project with no tags. `tests` carries the parsed per-test
 * data when the reporter sentinel path produced it, so `/api/tags` keeps its
 * per-test grouping; the fallback paths yield only `tags`.
 */
export type ProjectTagsResult =
  | { ok: true; tags: Set<string>; tests?: TestSummary[] }
  | { ok: false };

function parseReporterPayload(output: string): ReporterPayload | null {
  const begin = output.indexOf('__TAG_DATA_BEGIN__');
  const end = output.indexOf('__TAG_DATA_END__');
  if (begin === -1 || end === -1 || end < begin) return null;
  const slice = output.slice(begin + '__TAG_DATA_BEGIN__'.length, end).trim();
  try {
    const parsed = JSON.parse(slice) as ReporterPayload;
    return Array.isArray(parsed.tests) ? parsed : null;
  } catch {
    return null;
  }
}

function parsePlaywrightListTags(output: string): string[] {
  const tags = new Set<string>();
  for (const m of output.matchAll(/@[\w-]+/g)) {
    if (m[0]) tags.add(m[0]);
  }
  return [...tags];
}

async function parseRobotTagsFromFiles(
  tool: ToolId,
  type: string,
  project: string,
): Promise<string[]> {
  const manifest = await getToolManifest(tool);
  if (!manifest) return [];
  const specsDir = path.join(
    TOOLS_DIR,
    tool,
    manifest.projects.root,
    type,
    project,
    manifest.projects.specsSubdir,
  );
  if (!fs.existsSync(specsDir)) return [];
  const tags = new Set<string>();
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.robot')) {
        const content = fs.readFileSync(full, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('[Tags]')) continue;
          for (const t of trimmed
            .slice('[Tags]'.length)
            .trim()
            .split(/\s{2,}|\t+/)) {
            const clean = t.trim();
            if (clean && !clean.startsWith('$') && !clean.startsWith('%')) tags.add(clean);
          }
        }
      }
    }
  }
  walk(specsDir);
  return [...tags];
}

async function execCapture(cmd: string): Promise<string> {
  const result = await runChild(cmd, [], {
    cwd: WORKSPACE_ROOT,
    timeoutMs: 60_000,
    shell: BASH_PATH,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  // Reporters may exit non-zero (e.g. a tool failure) while still having emitted
  // the sentinel block on stdout; on failure include stderr too so the caller
  // can fall back to the legacy text parsers.
  return result.ok ? result.stdout : result.stdout + result.stderr;
}

/** Flatten the reporter per-test tag lists into one set. */
function tagsFromTests(tests: TestSummary[]): Set<string> {
  const tags = new Set<string>();
  for (const t of tests) for (const tag of t.tags) tags.add(tag);
  return tags;
}

export const TAGS_CACHE_MAX_AGE_MS = 10 * 60_000;

interface TagsCacheEntry {
  fingerprint: string;
  at: number;
  result: Extract<ProjectTagsResult, { ok: true }>;
}

const tagsCache = new Map<string, TagsCacheEntry>();
const tagsInflight = new Map<string, Promise<ProjectTagsResult>>();

function cacheKey(tool: ToolId, type: string, project: string): string {
  return `${tool}|${type}|${project}`;
}

function foldStat(st: fs.Stats, agg: { count: number; maxMtime: number; size: number }): void {
  agg.count += 1;
  agg.size += st.size;
  if (st.mtimeMs > agg.maxMtime) agg.maxMtime = st.mtimeMs;
}

function foldTree(dir: string, agg: { count: number; maxMtime: number; size: number }): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      foldTree(full, agg);
    } else if (entry.isFile()) {
      try {
        foldStat(fs.statSync(full), agg);
      } catch {}
    }
  }
}

function foldTopLevel(dir: string, agg: { count: number; maxMtime: number; size: number }): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      foldStat(fs.statSync(path.join(dir, entry.name)), agg);
    } catch {}
  }
}

async function findProjectDir(tool: ToolId, type: string, project: string): Promise<string | null> {
  try {
    const all = await listAllProjects();
    const hit = all.find((p) => p.tool === tool && p.type === type && p.name === project);
    if (hit) return hit.path;
  } catch {}
  return null;
}

async function computeTagsFingerprint(
  tool: ToolId,
  type: string,
  project: string,
): Promise<string | null> {
  const projectDir = await findProjectDir(tool, type, project);
  if (!projectDir) return null;
  const agg = { count: 0, maxMtime: 0, size: 0 };
  foldTree(path.join(projectDir, 'automations'), agg);
  foldTopLevel(projectDir, agg);
  foldTopLevel(path.join(TOOLS_DIR, tool), agg);
  return `${agg.count}\u0000${agg.maxMtime}\u0000${agg.size}`;
}

/**
 * Resolve the tags a project actually emits right now, scoped to one
 * tool+type+project. Primary path parses the reporter sentinel block; the
 * manifest `tags.strategy` governs only the fallback when no sentinel was
 * emitted. Never throws for a scan miss — returns `ok: false` instead, so both
 * the bookmark list and the migrate mutation branch deterministically.
 */
async function scanProjectTags(
  tool: ToolId,
  type: string,
  project: string,
): Promise<ProjectTagsResult> {
  try {
    const output = await execCapture(await buildTagsCommand(tool, type, project));
    let payload = parseReporterPayload(output);
    let fallbackTags: string[] = [];

    const caps = await getToolCapabilities(tool);
    const strategy = caps?.tags.strategy ?? 'none';

    if (!payload && strategy === 'playwright-list') {
      const listOutput = await execCapture(await buildPlaywrightListCommand(tool, type, project));
      payload = parseReporterPayload(listOutput);
      if (!payload) fallbackTags = parsePlaywrightListTags(listOutput);
    } else if (!payload && strategy === 'robot-files') {
      fallbackTags = await parseRobotTagsFromFiles(tool, type, project);
    }

    if (payload?.tests && payload.tests.length > 0) {
      return { ok: true, tags: tagsFromTests(payload.tests), tests: payload.tests };
    }
    if (fallbackTags.length > 0) {
      return { ok: true, tags: new Set(fallbackTags) };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

export async function resolveProjectTags(
  tool: ToolId,
  type: string,
  project: string,
): Promise<ProjectTagsResult> {
  const key = cacheKey(tool, type, project);

  const inflight = tagsInflight.get(key);
  if (inflight) return inflight;

  const run = (async (): Promise<ProjectTagsResult> => {
    const fingerprint = await computeTagsFingerprint(tool, type, project);
    if (fingerprint !== null) {
      const cached = tagsCache.get(key);
      if (
        cached &&
        cached.fingerprint === fingerprint &&
        Date.now() - cached.at < TAGS_CACHE_MAX_AGE_MS
      ) {
        return cached.result;
      }
    }

    const result = await scanProjectTags(tool, type, project);
    if (result.ok && fingerprint !== null) {
      tagsCache.set(key, { fingerprint, at: Date.now(), result });
    }
    return result;
  })();

  tagsInflight.set(key, run);
  try {
    return await run;
  } finally {
    tagsInflight.delete(key);
  }
}

export function invalidateProjectTagsCache(): void {
  tagsCache.clear();
}
