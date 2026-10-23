import fs, { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProjectSummary, ToolId } from '@hub/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunChild = vi.fn();
vi.mock('../exec.js', () => ({
  runChild: (...args: unknown[]) => mockRunChild(...args),
}));

const mockListAllProjects = vi.fn<() => Promise<ProjectSummary[]>>();
vi.mock('../scanner.js', () => ({
  listAllProjects: () => mockListAllProjects(),
}));

import {
  invalidateProjectTagsCache,
  resolveProjectTags,
  TAGS_CACHE_MAX_AGE_MS,
} from '../project-tags.js';

const TOOL: ToolId = 'playwright' as ToolId;
const TYPE = 'web';
const PROJECT = 'demo';

function sentinel(tag = '@smoke'): string {
  const payload = JSON.stringify({
    tool: TOOL,
    tests: [{ id: 'T1', title: 'a case', tags: [tag] }],
  });
  return `__TAG_DATA_BEGIN__${payload}__TAG_DATA_END__`;
}

let projectDir: string;

function mockProjectDir(dir: string): void {
  mockListAllProjects.mockResolvedValue([
    {
      tool: TOOL,
      type: TYPE,
      name: PROJECT,
      path: dir,
      hasEnv: false,
      hasEnvTemplate: false,
      missingEnvKeys: [],
      isGitRepo: false,
    },
  ]);
}

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), 'ptc-'));
  mkdirSync(path.join(projectDir, 'automations', 'specs'), { recursive: true });
  writeFileSync(path.join(projectDir, 'automations', 'specs', 'a.spec.ts'), 'x', 'utf8');
  mockProjectDir(projectDir);
  mockRunChild.mockReset();
  mockRunChild.mockResolvedValue({ ok: true, stdout: sentinel(), stderr: '', code: 0 });
  invalidateProjectTagsCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('resolveProjectTags — cache', () => {
  it('shares one scan across concurrent callers (one spawn)', async () => {
    const [a, b, c] = await Promise.all([
      resolveProjectTags(TOOL, TYPE, PROJECT),
      resolveProjectTags(TOOL, TYPE, PROJECT),
      resolveProjectTags(TOOL, TYPE, PROJECT),
    ]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(mockRunChild).toHaveBeenCalledTimes(1);
  });

  it('does not re-scan a repeat with no change (cache hit)', async () => {
    await resolveProjectTags(TOOL, TYPE, PROJECT);
    expect(mockRunChild).toHaveBeenCalledTimes(1);
    const again = await resolveProjectTags(TOOL, TYPE, PROJECT);
    expect(again.ok).toBe(true);
    expect(mockRunChild).toHaveBeenCalledTimes(1);
  });

  it('re-scans when a project file changes (fingerprint miss)', async () => {
    await resolveProjectTags(TOOL, TYPE, PROJECT);
    expect(mockRunChild).toHaveBeenCalledTimes(1);

    const spec = path.join(projectDir, 'automations', 'specs', 'a.spec.ts');
    const future = new Date(Date.now() + 10_000);
    utimesSync(spec, future, future);

    await resolveProjectTags(TOOL, TYPE, PROJECT);
    expect(mockRunChild).toHaveBeenCalledTimes(2);
  });

  it('never caches an ok:false scan', async () => {
    mockRunChild.mockResolvedValue({ ok: true, stdout: 'no tags here', stderr: '', code: 0 });
    const first = await resolveProjectTags(TOOL, TYPE, PROJECT);
    expect(first.ok).toBe(false);
    const spawnsAfterFirst = mockRunChild.mock.calls.length;

    const second = await resolveProjectTags(TOOL, TYPE, PROJECT);
    expect(second.ok).toBe(false);
    expect(mockRunChild.mock.calls.length).toBeGreaterThan(spawnsAfterFirst);
  });

  it('re-scans once the cache entry exceeds TAGS_CACHE_MAX_AGE_MS', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    await resolveProjectTags(TOOL, TYPE, PROJECT);
    expect(mockRunChild).toHaveBeenCalledTimes(1);

    vi.setSystemTime(TAGS_CACHE_MAX_AGE_MS - 1);
    await resolveProjectTags(TOOL, TYPE, PROJECT);
    expect(mockRunChild).toHaveBeenCalledTimes(1);

    vi.setSystemTime(TAGS_CACHE_MAX_AGE_MS + 1);
    await resolveProjectTags(TOOL, TYPE, PROJECT);
    expect(mockRunChild).toHaveBeenCalledTimes(2);
  });

  it('removes the in-flight entry on rejection so a later call retries', async () => {
    mockRunChild.mockRejectedValueOnce(new Error('spawn failed'));
    const first = await resolveProjectTags(TOOL, TYPE, PROJECT);
    expect(first.ok).toBe(false);

    mockRunChild.mockResolvedValue({ ok: true, stdout: sentinel(), stderr: '', code: 0 });
    const second = await resolveProjectTags(TOOL, TYPE, PROJECT);
    expect(second.ok).toBe(true);
    expect(fs.existsSync(projectDir)).toBe(true);
  });
});
