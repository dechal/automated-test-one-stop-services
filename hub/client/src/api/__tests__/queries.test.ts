import { afterEach, describe, expect, it, vi } from 'vitest';

// Capture the URL each factory's queryFn requests without hitting the network.
const calls: string[] = [];
vi.mock('~/api/client.js', () => ({
  api: {
    get: (path: string) => {
      calls.push(path);
      return Promise.resolve(undefined);
    },
    post: (path: string) => {
      calls.push(path);
      return Promise.resolve(undefined);
    },
    put: (path: string) => {
      calls.push(path);
      return Promise.resolve(undefined);
    },
    delete: (path: string) => {
      calls.push(path);
      return Promise.resolve(undefined);
    },
  },
}));

import * as queries from '~/api/queries.js';
import { queryRoots } from '~/api/queries.js';

/**
 * Invoke every exported `q*` factory with placeholder args so its queryKey and
 * queryFn can be inspected. The axis args are harmless strings; `enabled`
 * gating is not exercised here, only key/URL/staleTime shape.
 */
function allFactories(): Array<{ name: string; options: ReturnType<typeof queries.qDoctor> }> {
  const out: Array<{ name: string; options: ReturnType<typeof queries.qDoctor> }> = [];
  for (const [name, value] of Object.entries(queries)) {
    if (!/^q[A-Z]/.test(name) || typeof value !== 'function') continue;
    // Give every positional arg a placeholder; factories ignore extras.
    const fn = value as (...args: unknown[]) => ReturnType<typeof queries.qDoctor>;
    const options = fn('pw', 'web', 'demo', 'extra');
    out.push({ name, options });
  }
  return out;
}

afterEach(() => {
  calls.length = 0;
});

describe('query factories', () => {
  const rootValues = new Set<string>(Object.values(queryRoots));

  it('every factory key starts with a queryRoots root', () => {
    for (const { name, options } of allFactories()) {
      const root = (options.queryKey as readonly unknown[])[0];
      expect(typeof root, `${name} root must be a string`).toBe('string');
      expect(
        rootValues.has(root as string),
        `${name} root "${String(root)}" not in queryRoots`,
      ).toBe(true);
    }
  });

  it('no two factories share a root with different request URLs', () => {
    const urlByRoot = new Map<string, string>();
    for (const { name, options } of allFactories()) {
      const root = (options.queryKey as readonly unknown[])[0] as string;
      calls.length = 0;
      // Running the queryFn records the path it would fetch.
      void (options.queryFn as (ctx: unknown) => unknown)?.({
        queryKey: options.queryKey,
        signal: undefined,
        meta: undefined,
      });
      const url = calls[0];
      if (url === undefined) continue; // factory with a static/placeholder fetcher
      // id-fold the dynamic segments so /api/runs/:id/report compares stable.
      const base = url.split('?')[0] ?? url;
      const folded = base.replace(/\/(pw|web|demo|extra|undefined)(?=\/|$)/g, '/:id');
      const prev = urlByRoot.get(root);
      if (prev === undefined) urlByRoot.set(root, folded);
      else expect(prev, `root "${root}" (${name}) maps to two URLs`).toBe(folded);
    }
  });

  it('documented staleTime per resource matches the tier table', () => {
    const byName = new Map(allFactories().map((f) => [f.name, f.options] as const));
    // Tiers today's-lowest: structural 5m, moderate 60s, short 30s, probe 10-15s,
    // session-stable Infinity, and the live/default-0 queries carry none.
    expect(byName.get('qProjects')?.staleTime).toBe(60_000);
    expect(byName.get('qDoctor')?.staleTime).toBe(10_000);
    expect(byName.get('qCredentials')?.staleTime).toBe(15_000);
    expect(byName.get('qTools')?.staleTime).toBe(15_000);
    expect(byName.get('qUsageLogging')?.staleTime).toBe(15_000);
    expect(byName.get('qToolRegistry')?.staleTime).toBe(60_000);
    expect(byName.get('qConfig')?.staleTime).toBe(Number.POSITIVE_INFINITY);
    expect(byName.get('qGitStatus')?.staleTime).toBe(4 * 60_000);
    // Live / default-0 axes never pin a staleTime (so they never read as stale).
    expect(byName.get('qActiveRuns')?.staleTime).toBeUndefined();
    expect(byName.get('qQueue')?.staleTime).toBeUndefined();
    expect(byName.get('qBookmarks')?.staleTime).toBeUndefined();
  });

  it('queryRoots values are unique', () => {
    const values = Object.values(queryRoots);
    expect(new Set(values).size).toBe(values.length);
  });
});
