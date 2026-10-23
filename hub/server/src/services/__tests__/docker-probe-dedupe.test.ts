import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface RunChildResultLike {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  output: string;
}

const mockRunChild =
  vi.fn<(cmd: string, args: string[], opts: unknown) => Promise<RunChildResultLike>>();
vi.mock('../exec.js', () => ({
  runChild: (cmd: string, args: string[], opts: unknown) => mockRunChild(cmd, args, opts),
}));

function ok(stdout = ''): RunChildResultLike {
  return { ok: true, code: 0, stdout, stderr: '', output: stdout };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

import {
  getComposeServiceStatus,
  invalidateDockerStatusCache,
  isDockerRunning,
} from '../docker.js';

beforeEach(() => {
  mockRunChild.mockReset();
  invalidateDockerStatusCache();
});

afterEach(() => {
  invalidateDockerStatusCache();
});

describe('docker probe dedupe', () => {
  it('isDockerRunning: concurrent callers share one `docker info` spawn', async () => {
    const d = deferred<RunChildResultLike>();
    mockRunChild.mockReturnValue(d.promise);

    const a = isDockerRunning();
    const b = isDockerRunning();
    d.resolve(ok());
    const [ra, rb] = await Promise.all([a, b]);

    expect(ra).toBe(true);
    expect(rb).toBe(true);
    expect(mockRunChild).toHaveBeenCalledTimes(1);
    expect(mockRunChild.mock.calls[0]?.[0]).toBe('docker');
    expect(mockRunChild.mock.calls[0]?.[1]).toEqual(['info']);
  });

  it('getComposeServiceStatus: two concurrent callers share one `docker compose ps` spawn', async () => {
    const d = deferred<RunChildResultLike>();
    mockRunChild.mockReturnValue(d.promise);

    const a = getComposeServiceStatus('influxdb');
    const b = getComposeServiceStatus('grafana');
    d.resolve(
      ok(
        `${JSON.stringify({ Service: 'influxdb', State: 'running' })}\n${JSON.stringify({ Service: 'grafana', State: 'exited' })}`,
      ),
    );
    const [ra, rb] = await Promise.all([a, b]);

    expect(ra).toBe('running');
    expect(rb).toBe('stopped');
    expect(mockRunChild).toHaveBeenCalledTimes(1);
    expect(mockRunChild.mock.calls[0]?.[1]).toEqual(['compose', 'ps', '--all', '--format', 'json']);
  });

  it('invalidate clears both the value cache and the in-flight promise, forcing a re-probe', async () => {
    mockRunChild.mockResolvedValue(ok());
    expect(await isDockerRunning()).toBe(true);
    expect(mockRunChild).toHaveBeenCalledTimes(1);

    invalidateDockerStatusCache();

    expect(await isDockerRunning()).toBe(true);
    expect(mockRunChild).toHaveBeenCalledTimes(2);
  });

  it('a settled probe is cached within TTL and does not re-spawn', async () => {
    mockRunChild.mockResolvedValue(ok());
    await isDockerRunning();
    await isDockerRunning();
    expect(mockRunChild).toHaveBeenCalledTimes(1);
  });
});

describe('appium isInstalled cache', () => {
  it('two calls spawn `appium --version` once, and re-probes after a successful install', async () => {
    vi.resetModules();
    const { appiumServer } = await import('../appium-server.js');

    mockRunChild.mockResolvedValue(ok('2.0.0'));
    expect(await appiumServer.isInstalled()).toBe(true);
    expect(await appiumServer.isInstalled()).toBe(true);
    const versionCalls = mockRunChild.mock.calls.filter(
      (c) => c[0] === 'appium' && c[1]?.[0] === '--version',
    );
    expect(versionCalls).toHaveLength(1);

    mockRunChild.mockClear();
    mockRunChild.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'npm') return ok();
      if (cmd === 'appium' && args[0] === 'driver') return ok();
      return ok('2.0.0');
    });
    await appiumServer.install();

    await appiumServer.isInstalled();
    const reprobe = mockRunChild.mock.calls.filter(
      (c) => c[0] === 'appium' && c[1]?.[0] === '--version',
    );
    expect(reprobe).toHaveLength(1);
  });
});
