import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// hub-rebuild spawns the Hub's own build + restart, so nothing here may run for
// real: `runChild` and `spawn` are replaced. What the tests pin is the ORDER
// (client before server), the stop-at-first-failure property, and the restart
// contract — the three things the two callers (system.ts, git.ts) depend on and
// which used to be duplicated per caller.
const mocks = vi.hoisted(() => ({ runChild: vi.fn(), spawn: vi.fn() }));

vi.mock('../exec.js', () => ({ runChild: mocks.runChild }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import { WORKSPACE_ROOT } from '../../config.js';
import { type RebuildStage, rebuildHub, scheduleHubRestart } from '../hub-rebuild.js';

const ok = { ok: true, code: 0, stdout: '', stderr: '', output: '' };
const fail = (output: string) => ({ ok: false, code: 1, stdout: '', stderr: output, output });

beforeEach(() => {
  mocks.runChild.mockReset();
  mocks.spawn.mockReset();
});

describe('rebuildHub', () => {
  it('builds the client, then the server, and reports the stages in that order', async () => {
    mocks.runChild.mockResolvedValue(ok);
    const stages: RebuildStage[] = [];

    const result = await rebuildHub((stage) => stages.push(stage));

    expect(result).toEqual({ ok: true });
    expect(stages).toEqual(['client', 'server']);
    expect(mocks.runChild).toHaveBeenCalledTimes(2);
    expect(mocks.runChild.mock.calls[0]).toEqual([
      'pnpm',
      ['-C', 'hub/client', 'run', 'build'],
      { cwd: WORKSPACE_ROOT, shell: process.platform === 'win32' },
    ]);
    expect(mocks.runChild.mock.calls[1]?.[1]).toEqual(['-C', 'hub/server', 'run', 'build']);
  });

  it('reports the stage BEFORE its build runs, so a caller can publish progress', async () => {
    const seen: string[] = [];
    mocks.runChild.mockImplementation((_cmd: string, args: string[]) => {
      seen.push(`build:${args[1]}`);
      return Promise.resolve(ok);
    });

    await rebuildHub((stage) => seen.push(`stage:${stage}`));

    expect(seen).toEqual(['stage:client', 'build:hub/client', 'stage:server', 'build:hub/server']);
  });

  it('stops at a failed client build and never starts the server build', async () => {
    mocks.runChild.mockResolvedValueOnce(fail('vite: out of memory'));

    const result = await rebuildHub();

    expect(result).toEqual({ ok: false, failedAt: 'client', output: 'vite: out of memory' });
    expect(mocks.runChild).toHaveBeenCalledTimes(1);
  });

  it('reports a failed server build with its output', async () => {
    mocks.runChild.mockResolvedValueOnce(ok).mockResolvedValueOnce(fail('tsup: TS2304'));

    const result = await rebuildHub();

    expect(result).toEqual({ ok: false, failedAt: 'server', output: 'tsup: TS2304' });
    expect(mocks.runChild).toHaveBeenCalledTimes(2);
  });

  it('never throws — a failure is a return value, because the callers run it detached', async () => {
    mocks.runChild.mockResolvedValue(fail(''));
    await expect(rebuildHub()).resolves.toMatchObject({ ok: false });
  });
});

describe('scheduleHubRestart', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Minimal ChildProcess stand-in: records the 'error' handler, counts unref. */
  function fakeChild() {
    const handlers = new Map<string, (err: Error) => void>();
    return {
      on: vi.fn((event: string, cb: (err: Error) => void) => handlers.set(event, cb)),
      unref: vi.fn(),
      emitError: (err: Error) => handlers.get('error')?.(err),
    };
  }

  it('waits before restarting, so the status endpoint can be polled one last time', () => {
    mocks.spawn.mockReturnValue(fakeChild());

    scheduleHubRestart(() => undefined);
    expect(mocks.spawn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('runs the shared launcher detached, so the restart survives this process', () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);

    scheduleHubRestart(() => undefined, 0);
    vi.advanceTimersByTime(0);

    const hubDir = path.resolve(WORKSPACE_ROOT, 'hub');
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      [path.join(hubDir, 'bin', 'hub-service.mjs'), 'restart'],
      { cwd: hubDir, detached: true, stdio: 'ignore', windowsHide: true },
    );
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('surfaces a launcher that could not be spawned — the case that leaves the old process alive', () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const onError = vi.fn();

    scheduleHubRestart(onError, 0);
    vi.advanceTimersByTime(0);
    child.emitError(new Error('ENOENT'));

    expect(onError).toHaveBeenCalledWith('hub restart failed: ENOENT');
  });
});
