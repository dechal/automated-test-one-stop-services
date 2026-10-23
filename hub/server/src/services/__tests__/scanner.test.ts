import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The scanner derives its tool list + project layout from the manifest registry
// and reads files under TOOLS_DIR. Mock both so a NON-built-in tool (cypress)
// can be proven to scan exactly like a built-in.
const hoisted = vi.hoisted(() => ({
  toolsDir: '',
  manifests: [] as Array<{
    id: string;
    projects: {
      root: string;
      depth: 1 | 2;
      typeAxis: boolean;
      fixedType: string | null;
      specsSubdir: string;
      sectionAxis: boolean;
    };
  }>,
}));

vi.mock('../../config.js', async (orig) => {
  const actual = await orig<typeof import('../../config.js')>();
  return {
    ...actual,
    get TOOLS_DIR() {
      return hoisted.toolsDir;
    },
  };
});

vi.mock('../manifest-registry.js', () => ({
  getEnabledTools: async () => hoisted.manifests,
  getToolManifest: async (id: string) => hoisted.manifests.find((m) => m.id === id),
}));

const execHoisted = vi.hoisted(() => ({
  runChild: vi.fn(async () => ({
    ok: true,
    code: 0,
    stdout: 'git@example.com:org/repo.git',
    stderr: '',
    output: 'git@example.com:org/repo.git',
  })),
}));
vi.mock('../exec.js', () => ({ runChild: execHoisted.runChild }));

import { listAllProjects, listProjects, listSections, listTypes } from '../scanner.js';

const cypressProjects = {
  root: 'projects',
  depth: 2 as const,
  typeAxis: true,
  fixedType: null,
  specsSubdir: 'automations/specs',
  sectionAxis: false,
};

describe('scanner (manifest-driven, non-built-in tool)', () => {
  beforeEach(() => {
    hoisted.toolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-'));
    hoisted.manifests = [{ id: 'cypress', projects: cypressProjects }];
    // tools/cypress/projects/e2e/my-app  +  a template-example that must be excluded
    fs.mkdirSync(path.join(hoisted.toolsDir, 'cypress', 'projects', 'e2e', 'my-app'), {
      recursive: true,
    });
    fs.mkdirSync(
      path.join(hoisted.toolsDir, 'cypress', 'projects', 'e2e', 'cypress-e2e-template-example'),
      { recursive: true },
    );
  });

  afterEach(() => {
    fs.rmSync(hoisted.toolsDir, { recursive: true, force: true });
  });

  it('listTypes reads the type-axis folders from the manifest', async () => {
    expect(await listTypes('cypress')).toEqual(['e2e']);
  });

  it('listTypes returns [] for an unknown tool', async () => {
    expect(await listTypes('does-not-exist')).toEqual([]);
  });

  it('listProjects excludes template-example folders', async () => {
    expect(await listProjects('cypress', 'e2e')).toEqual(['my-app']);
  });

  it('buildAllProjects (via listAllProjects) includes the non-built-in project', async () => {
    const all = await listAllProjects();
    expect(all.map((p) => `${p.tool}/${p.type}/${p.name}`)).toEqual(['cypress/e2e/my-app']);
  });

  it('a disabled/removed tool disappears after cache invalidation', async () => {
    const { invalidateProjectCache } = await import('../scanner.js');
    expect((await listAllProjects()).length).toBe(1);
    hoisted.manifests = []; // tool disabled
    invalidateProjectCache();
    expect((await listAllProjects()).length).toBe(0);
  });

  it('fixed-type + section-axis tool resolves leaf sections (dirs with e2e.spec.ts)', async () => {
    hoisted.manifests = [
      {
        id: 'k6',
        projects: {
          root: 'projects',
          depth: 1,
          typeAxis: false,
          fixedType: 'performance',
          specsSubdir: 'automations/specs',
          sectionAxis: true,
        },
      },
    ];
    const specsDir = path.join(
      hoisted.toolsDir,
      'k6',
      'projects',
      'performance',
      'load-app',
      'automations',
      'specs',
    );
    // Flat section, two nested sections under `ta`, and a bare parent dir with
    // no spec of its own (must NOT be listed — it isn't runnable).
    const spec = 'e2e.spec.ts';
    for (const rel of ['checkout', 'ta/domestic', 'ta/inter']) {
      fs.mkdirSync(path.join(specsDir, rel), { recursive: true });
      fs.writeFileSync(path.join(specsDir, rel, spec), '');
    }
    fs.mkdirSync(path.join(specsDir, 'no-spec-parent'), { recursive: true });

    expect(await listTypes('k6')).toEqual(['performance']);
    // Sorted, slash-joined leaf paths; the bare `ta` / `no-spec-parent` parents
    // are excluded because they have no spec.
    expect(await listSections('load-app')).toEqual(['checkout', 'ta/domestic', 'ta/inter']);
  });
});

describe('scanner git-remote memoization (d1j)', () => {
  beforeEach(async () => {
    const { invalidateProjectCache } = await import('../scanner.js');
    vi.clearAllMocks();
    vi.useFakeTimers();
    invalidateProjectCache();
    hoisted.toolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-remote-'));
    hoisted.manifests = [{ id: 'cypress', projects: cypressProjects }];
    const proj = path.join(hoisted.toolsDir, 'cypress', 'projects', 'e2e', 'repo-app');
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  });

  afterEach(async () => {
    const { invalidateProjectCache } = await import('../scanner.js');
    vi.useRealTimers();
    invalidateProjectCache();
    fs.rmSync(hoisted.toolsDir, { recursive: true, force: true });
  });

  it('a warm remote cache means a rebuild after the project TTL does not re-spawn git remote', async () => {
    const { invalidateProjectCache } = await import('../scanner.js');
    const first = await listAllProjects();
    expect(first.map((p) => p.gitRemoteUrl)).toEqual(['git@example.com:org/repo.git']);
    expect(execHoisted.runChild).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(31_000);
    const second = await listAllProjects();
    expect(second.map((p) => p.gitRemoteUrl)).toEqual(['git@example.com:org/repo.git']);
    expect(execHoisted.runChild).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10 * 60_000 + 1_000);
    invalidateProjectCache();
    await listAllProjects();
    expect(execHoisted.runChild).toHaveBeenCalledTimes(2);
  });
});
