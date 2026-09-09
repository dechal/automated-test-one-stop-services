import fs from 'node:fs';
import path from 'node:path';
import type { ProjectSummary, ToolId } from '@hub/shared';
import { TOOLS_DIR } from '../config.js';
import { mapPool } from '../lib/map-pool.js';
import { parseEnvToRecord } from './env-parser.js';
import { runChild } from './exec.js';
import { getEnabledTools, getToolManifest } from './manifest-registry.js';

const PROJECT_CACHE_TTL_MS = 30_000;
/** Concurrency cap for the per-project `git remote get-url` probes. */
const GIT_PROBE_CONCURRENCY = 6;

function listDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name);
}

function isTemplateName(name: string): boolean {
  return name.includes('-template-');
}

/**
 * Lists a tool's project types from its manifest: the type-axis folders under
 * `<root>` (depth 2), or the single `fixedType` slot (depth 1). Returns `[]`
 * for an unknown/disabled tool.
 */
export async function listTypes(tool: ToolId): Promise<string[]> {
  const manifest = await getToolManifest(tool);
  if (!manifest) return [];
  const { root, typeAxis, fixedType } = manifest.projects;
  if (!typeAxis) return fixedType ? [fixedType] : [];
  return listDirs(path.join(TOOLS_DIR, tool, root));
}

/** Lists non-template projects under `tools/<tool>/<root>/<type>/`. */
export async function listProjects(tool: ToolId, type: string): Promise<string[]> {
  const manifest = await getToolManifest(tool);
  if (!manifest) return [];
  const dir = path.join(TOOLS_DIR, tool, manifest.projects.root, type);
  return listDirs(dir).filter((n) => !isTemplateName(n));
}

export function readMissingEnvKeys(projectDir: string): {
  hasEnv: boolean;
  hasTemplate: boolean;
  missing: string[];
} {
  const envPath = path.join(projectDir, '.env');
  const tplPath = path.join(projectDir, '.env.template');
  const hasEnv = fs.existsSync(envPath);
  const hasTemplate = fs.existsSync(tplPath);

  if (!hasTemplate) return { hasEnv, hasTemplate, missing: [] };

  const tpl = parseEnvToRecord(fs.readFileSync(tplPath, 'utf8'));
  const env = hasEnv ? parseEnvToRecord(fs.readFileSync(envPath, 'utf8')) : {};

  const missing: string[] = [];
  for (const key of Object.keys(tpl)) {
    const value = env[key];
    if (value === undefined) {
      missing.push(key);
      continue;
    }
    if (!value || value === 'null' || value === 'undefined') {
      missing.push(key);
    }
  }
  return { hasEnv, hasTemplate, missing };
}

interface ProjectSummaryBase extends Omit<ProjectSummary, 'gitRemoteUrl'> {
  /** True when the project has a `.git` directory; drives whether we probe the remote. */
  _isGit: boolean;
}

/**
 * Read project metadata from disk. Pure sync work — file existence and env
 * parsing only. Git remote lookup is split out so callers can run it in
 * parallel without blocking the event loop on per-project execFileSync.
 */
function projectSummaryBase(
  tool: ToolId,
  type: string,
  name: string,
  root: string,
): ProjectSummaryBase {
  const projectDir = path.join(TOOLS_DIR, tool, root, type, name);
  const { hasEnv, hasTemplate, missing } = readMissingEnvKeys(projectDir);
  const isGitRepo = fs.existsSync(path.join(projectDir, '.git'));
  return {
    tool,
    type,
    name,
    path: projectDir,
    hasEnv,
    hasEnvTemplate: hasTemplate,
    missingEnvKeys: missing,
    isGitRepo,
    _isGit: isGitRepo,
  };
}

async function readGitRemote(projectDir: string): Promise<string | undefined> {
  const res = await runChild('git', ['remote', 'get-url', 'origin'], {
    cwd: projectDir,
    timeoutMs: 5000,
  });
  if (!res.ok) return undefined;
  const url = res.stdout.trim();
  return url || undefined;
}

/**
 * Cached `listAllProjects()`. The dashboard polls this often and the
 * git-remote probes per project are the slow part. Cache for ~30s; invalidate
 * on any project create/clone via `invalidateProjectCache()`.
 *
 * Returns a shallow copy on every call so callers cannot mutate the cache.
 */
let cache: { value: ProjectSummary[]; at: number } | null = null;
let inflight: Promise<ProjectSummary[]> | null = null;

async function buildAllProjects(): Promise<ProjectSummary[]> {
  // Phase 1: filesystem scan driven by the manifest registry.
  const bases: ProjectSummaryBase[] = [];
  for (const manifest of await getEnabledTools()) {
    const tool = manifest.id;
    for (const type of await listTypes(tool)) {
      for (const name of await listProjects(tool, type)) {
        bases.push(projectSummaryBase(tool, type, name, manifest.projects.root));
      }
    }
  }

  // Phase 2: bounded-concurrency git remote probes for the git repos only.
  const gitBases = bases.filter((b) => b._isGit);
  const remotes = await mapPool(gitBases, GIT_PROBE_CONCURRENCY, (b) => readGitRemote(b.path));

  // Splice remotes back into their owning summaries.
  const remoteMap = new Map<string, string | undefined>();
  for (let i = 0; i < gitBases.length; i++) {
    const base = gitBases[i];
    if (base) remoteMap.set(base.path, remotes[i]);
  }

  return bases.map((b) => {
    const { _isGit, ...rest } = b;
    const url = remoteMap.get(rest.path);
    return { ...rest, ...(url ? { gitRemoteUrl: url } : {}) };
  });
}

export async function listAllProjects(): Promise<ProjectSummary[]> {
  const now = Date.now();
  if (cache && now - cache.at < PROJECT_CACHE_TTL_MS) return [...cache.value];

  // De-dupe concurrent rebuilds: if a probe is already in-flight, await it.
  if (inflight) return inflight.then((v) => [...v]);

  inflight = buildAllProjects().then((value) => {
    cache = { value, at: Date.now() };
    inflight = null;
    return value;
  });
  return inflight.then((v) => [...v]);
}

/** Drop the project cache — call after project create/clone/delete. */
export function invalidateProjectCache(): void {
  cache = null;
}

/** Sections for a section-axis tool (e.g. k6 `automations/specs/<section>/`). */
export async function listSections(project: string, tool?: ToolId): Promise<string[]> {
  const tools = await getEnabledTools();
  const manifest = tool
    ? tools.find((t) => t.id === tool && t.projects.sectionAxis)
    : tools.find((t) => t.projects.sectionAxis);
  if (!manifest) return [];
  const typeSlot = manifest.projects.fixedType ?? '';
  const specsRoot = path.join(
    TOOLS_DIR,
    manifest.id,
    manifest.projects.root,
    typeSlot,
    project,
    manifest.projects.specsSubdir,
  );
  return findSectionDirs(specsRoot);
}

/**
 * The section spec filename. A "section" is the directory that directly
 * contains this file — matching the Taskfile's `SPEC_FILE` and the manifest's
 * `pipeline.targetPaths` (`.../specs/{section}/e2e.spec.ts`).
 * Known limit: hardcoded here because the Hub's `ToolManifest` view doesn't expose
 * `pipeline.targetPaths`. Ceiling: if a tool ever uses a different spec
 * filename, source it from the manifest instead. Upgrade path: add the spec
 * basename to `ToolProjectsConfig` and read it here.
 */
const SECTION_SPEC_FILE = 'e2e.spec.ts';

/**
 * Recursively collect every directory under `root` that directly contains the
 * section spec file, returned as forward-slash paths relative to `root` and
 * sorted. This lists nested layouts (`ta/domestic`, `ta/inbound`) as runnable
 * sections rather than the bare parent (`ta`), which has no spec of its own and
 * would resolve to a non-existent `specs/ta/e2e.spec.ts`.
 */
function findSectionDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip rather than fail the whole scan
    }
    if (rel && entries.some((e) => e.isFile() && e.name === SECTION_SPEC_FILE)) {
      out.push(rel);
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) {
        walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
      }
    }
  };
  walk(root, '');
  return out.sort();
}
