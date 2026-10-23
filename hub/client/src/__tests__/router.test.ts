import { afterEach, describe, expect, it, vi } from 'vitest';
import { preloadAllRouteChunks, router } from '~/router.js';

const childRoutes = router.routeTree.children ?? [];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('router pending components', () => {
  it('registers at least one child route', () => {
    expect(childRoutes.length).toBeGreaterThan(0);
  });

  it('every child route has a pendingComponent', () => {
    for (const route of childRoutes) {
      expect(route.options.pendingComponent, `${route.id} must set a pendingComponent`).toBeTypeOf(
        'function',
      );
    }
  });

  it('sets defaultPendingMs 150 and defaultPendingMinMs 0', () => {
    expect(router.options.defaultPendingMs).toBe(150);
    expect(router.options.defaultPendingMinMs).toBe(0);
  });
});

describe('preloadAllRouteChunks', () => {
  it('calls loadRouteChunk once per child route for the component only', () => {
    const spy = vi.spyOn(router, 'loadRouteChunk').mockReturnValue(undefined);

    preloadAllRouteChunks();

    expect(spy).toHaveBeenCalledTimes(childRoutes.length);
    const preloaded = new Set(spy.mock.calls.map(([route]) => route));
    for (const route of childRoutes) {
      expect(preloaded.has(route), `${route.id} must be preloaded`).toBe(true);
    }
    for (const [, componentType] of spy.mock.calls) {
      expect(componentType).toBeUndefined();
    }
  });

  it('invokes no route loader while preloading', () => {
    vi.spyOn(router, 'loadRouteChunk').mockReturnValue(undefined);
    const loaderSpies: Array<ReturnType<typeof vi.fn>> = [];
    const restore: Array<() => void> = [];
    for (const route of childRoutes) {
      const options = route.options as { loader?: (...args: unknown[]) => unknown };
      const original = options.loader;
      if (typeof original !== 'function') continue;
      const spy = vi.fn(original);
      options.loader = spy;
      loaderSpies.push(spy);
      restore.push(() => {
        options.loader = original;
      });
    }

    preloadAllRouteChunks();

    for (const loaderSpy of loaderSpies) {
      expect(loaderSpy).not.toHaveBeenCalled();
    }
    for (const undo of restore) undo();
  });
});
