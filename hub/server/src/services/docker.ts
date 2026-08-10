import { WORKSPACE_ROOT } from '../config.js';
import { runChild } from './exec.js';

/**
 * Cached "is docker daemon up?".
 *
 * These two TTLs were 3s, well under the doctor's own cache, so `docker info`
 * and `docker compose ps` re-ran on nearly every sweep — and they are the only
 * probes that leave the machine (the CLI talks to Docker Desktop, which does its
 * own registry / update work). Both are now longer-lived, which is only safe
 * because every route that starts or stops something calls
 * `invalidateDockerStatusCache()` — `routes/docker.ts` did that for
 * `docker/start` alone, so service start/stop/restart and stop-all were added at
 * the same time as this TTL. A cache this long without them would keep reporting
 * a service the user just stopped as running.
 */
let dockerRunningCache: { value: boolean; checkedAt: number } | null = null;
const DOCKER_CACHE_TTL_MS = 30_000;

/**
 * Cache for `docker compose ps` results so back-to-back calls (the doctor
 * checks 3 services at once) reuse a single subprocess invocation.
 */
let composeStatusCache: { value: Map<string, ServiceStatus>; checkedAt: number } | null = null;
const COMPOSE_CACHE_TTL_MS = 30_000;

/**
 * Check whether the Docker daemon is responding to `docker info`.
 * Async, cached — every caller (doctor, /api/config, /api/docker/status, etc.)
 * shares the same probe.
 */
export async function isDockerRunning(): Promise<boolean> {
  const now = Date.now();
  if (dockerRunningCache && now - dockerRunningCache.checkedAt < DOCKER_CACHE_TTL_MS) {
    return dockerRunningCache.value;
  }
  const res = await runChild('docker', ['info'], { timeoutMs: 5_000 });
  const value = res.ok;
  dockerRunningCache = { value, checkedAt: now };
  return value;
}

/** Force the next call to re-probe (used after `docker desktop start`). */
export function invalidateDockerStatusCache(): void {
  dockerRunningCache = null;
  composeStatusCache = null;
}

export type ServiceStatus = 'running' | 'stopped' | 'unknown';

function classifyState(state: string): ServiceStatus {
  const s = state.toLowerCase();
  if (s === 'running') return 'running';
  if (s === 'exited' || s === 'dead' || s === 'stopped') return 'stopped';
  return 'unknown';
}

/**
 * Read every compose service's state in a single `docker compose ps` call.
 * Most compose versions emit NDJSON with `--format json`, but a few emit a
 * single JSON array instead — we accept both shapes.
 */
async function fetchAllComposeStatuses(): Promise<Map<string, ServiceStatus>> {
  const map = new Map<string, ServiceStatus>();
  const res = await runChild('docker', ['compose', 'ps', '--all', '--format', 'json'], {
    cwd: WORKSPACE_ROOT,
    timeoutMs: 10_000,
  });
  if (!res.ok) return map;

  const ingest = (obj: { Service?: string; Name?: string; State?: string }) => {
    const key = obj.Service ?? obj.Name;
    if (!key) return;
    map.set(key, classifyState(obj.State ?? ''));
  };

  const trimmed = res.stdout.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as Array<{
        Service?: string;
        Name?: string;
        State?: string;
      }>;
      if (Array.isArray(arr)) for (const obj of arr) ingest(obj);
    } catch {
      /* malformed array — fall through */
    }
    return map;
  }

  for (const line of trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)) {
    try {
      ingest(JSON.parse(line) as { Service?: string; Name?: string; State?: string });
    } catch {
      /* skip malformed rows */
    }
  }
  return map;
}

/**
 * Returns the state of a docker compose service.
 * Single shared probe for doctor + /api/docker/status. Results are cached
 * briefly so calling this for every service in a row only spawns one
 * `docker compose ps` invocation.
 */
export async function getComposeServiceStatus(service: string): Promise<ServiceStatus> {
  const now = Date.now();
  if (!composeStatusCache || now - composeStatusCache.checkedAt >= COMPOSE_CACHE_TTL_MS) {
    composeStatusCache = { value: await fetchAllComposeStatuses(), checkedAt: now };
  }
  return composeStatusCache.value.get(service) ?? 'stopped';
}
