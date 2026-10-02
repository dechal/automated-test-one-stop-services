import fs from 'node:fs';
import path from 'node:path';
import type { TestSummary, ToolId } from '@hub/shared';
import { BASH_PATH, WORKSPACE_ROOT } from '../config.js';
import { buildPlaywrightListCommand, buildTagsCommand } from './command-builder.js';
import { runChild } from './exec.js';
import { getToolCapabilities } from './manifest-registry.js';

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

function parseRobotTagsFromFiles(type: string, project: string): string[] {
  const specsDir = path.join(
    WORKSPACE_ROOT,
    'tools',
    'robot-framework',
    'projects',
    type,
    project,
    'automations',
    'specs',
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

/**
 * Resolve the tags a project actually emits right now, scoped to one
 * tool+type+project. Primary path parses the reporter sentinel block; the
 * manifest `tags.strategy` governs only the fallback when no sentinel was
 * emitted. Never throws for a scan miss — returns `ok: false` instead, so both
 * the bookmark list and the migrate mutation branch deterministically.
 */
export async function resolveProjectTags(
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
      fallbackTags = parseRobotTagsFromFiles(type, project);
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
