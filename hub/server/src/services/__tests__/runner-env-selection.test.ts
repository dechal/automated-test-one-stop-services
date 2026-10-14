import type { RunRequest } from '@hub/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reg = vi.hoisted(() => {
  process.env.HUB_DB_PATH = ':memory:';
  return {
    children: [] as Array<{
      cmd: string;
      pid: number;
      env: Record<string, string | undefined>;
      emit: (event: string, ...args: unknown[]) => boolean;
    }>,
    pid: 2000,
  };
});

vi.mock('../command-builder.js', () => ({
  buildTaskCommand: vi.fn(async () => 'task pw:run-local PROJECT=demo'),
}));

vi.mock('../manifest-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../manifest-registry.js')>();
  return { ...actual, getEnabledToolIds: vi.fn(async () => new Set(['playwright'])) };
});

const SELECTED_PROFILE = {
  id: 'prof-selected',
  name: 'Prod',
  environment: 'prod',
  tool: 'playwright',
  type: 'e2e',
  project: 'demo',
  entries: { BASE_URL: 'https://prod.example', IS_PROD: 'true' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const envProfileMocks = vi.hoisted(() => ({
  getById: vi.fn(),
  getActiveProfile: vi.fn(),
}));

vi.mock('../env-profiles.js', () => ({
  envProfileService: {
    getById: envProfileMocks.getById,
    getActiveProfile: envProfileMocks.getActiveProfile,
  },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');

  class FakeChild extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    pid: number;
    cmd: string;
    env: Record<string, string | undefined>;
    constructor(cmd: string, env: Record<string, string | undefined>) {
      super();
      this.cmd = cmd;
      this.env = env;
      this.pid = ++reg.pid;
    }
    kill(): boolean {
      return true;
    }
  }

  function spawn(
    cmd: string,
    opts?: { env?: Record<string, string | undefined> },
  ): import('node:child_process').ChildProcess {
    const child = new FakeChild(cmd, opts?.env ?? {});
    reg.children.push(child);
    return child as unknown as import('node:child_process').ChildProcess;
  }

  return { ...actual, spawn };
});

const { runner } = await import('../runner.js');

function latestRunChild() {
  for (let i = reg.children.length - 1; i >= 0; i--) {
    const c = reg.children[i];
    if (c) return c;
  }
  throw new Error('no run child spawned');
}

function makeConfig(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    tool: 'playwright',
    type: 'e2e',
    project: 'demo',
    mode: 'local',
    ...overrides,
  };
}

beforeEach(() => {
  reg.children.length = 0;
  envProfileMocks.getById.mockReset();
  envProfileMocks.getActiveProfile.mockReset();
  envProfileMocks.getById.mockImplementation((id: string) => {
    if (id === SELECTED_PROFILE.id) return SELECTED_PROFILE;
    if (id === 'prof-active-fallback') {
      return { ...SELECTED_PROFILE, id, environment: 'dev', entries: {} };
    }
    return undefined;
  });
  envProfileMocks.getActiveProfile.mockReturnValue('prof-active-fallback');
});

describe('runner env-profile carry selection', () => {
  it('sets environment from the selected envProfileId and merges its entries into the spawn env', () => {
    const record = runner.start(
      makeConfig({ envProfileId: SELECTED_PROFILE.id }),
      'task pw:run-local PROJECT=demo',
    );

    expect(record.environment).toBe('prod');
    expect(record.envProfileName).toBe('Prod');
    expect(envProfileMocks.getById).toHaveBeenCalledWith(SELECTED_PROFILE.id);
    expect(envProfileMocks.getActiveProfile).not.toHaveBeenCalled();

    const child = latestRunChild();
    expect(child.env.BASE_URL).toBe('https://prod.example');
    expect(child.env.IS_PROD).toBe('true');

    child.emit('close', 0, null);
  });

  it('profile entry overrides an inherited process.env key of the same name', () => {
    envProfileMocks.getById.mockReturnValue({
      ...SELECTED_PROFILE,
      entries: { PATH_UNRELATED: 'from-profile' },
    });
    process.env.PATH_UNRELATED = 'from-process';

    runner.start(
      makeConfig({ envProfileId: SELECTED_PROFILE.id }),
      'task pw:run-local PROJECT=demo',
    );

    const child = latestRunChild();
    expect(child.env.PATH_UNRELATED).toBe('from-profile');

    delete process.env.PATH_UNRELATED;
    child.emit('close', 0, null);
  });

  it('falls back to the reverse-match when envProfileId is absent', () => {
    const record = runner.start(makeConfig(), 'task pw:run-local PROJECT=demo');

    expect(envProfileMocks.getActiveProfile).toHaveBeenCalled();
    expect(record.environment).toBe('dev');
    expect(record.envProfileName).toBe('Prod');

    latestRunChild().emit('close', 0, null);
  });

  it('leaves envProfileName undefined when no profile resolves on the fallback path', () => {
    envProfileMocks.getActiveProfile.mockReturnValue(null);

    const record = runner.start(makeConfig(), 'task pw:run-local PROJECT=demo');

    expect(record.environment).toBeUndefined();
    expect(record.envProfileName).toBeUndefined();

    latestRunChild().emit('close', 0, null);
  });

  it('never leaks entry VALUES into the recorded command', () => {
    const record = runner.start(
      makeConfig({ envProfileId: SELECTED_PROFILE.id }),
      'task pw:run-local PROJECT=demo',
    );

    expect(record.command).not.toContain('https://prod.example');
    expect(record.command).not.toContain('IS_PROD');

    latestRunChild().emit('close', 0, null);
  });
});
