// Version-aware Playwright browser check — the pure comparison core.
//
// `findStaleBrowsers` is what turns a silent "old browser still on disk after a
// Playwright upgrade" into a failing Doctor check (which then surfaces the
// existing one-click Provision button). These cases pin the behaviour that the
// live `checkPlaywrightBrowsers` wiring depends on; the `fs.readdirSync` probe
// and `browsers.json` resolution around it are thin Node-stdlib calls exercised
// by the running Hub, not re-tested here.

import { describe, expect, it } from 'vitest';
import { findStaleBrowsers } from '../doctor.js';

type Expected = Map<string, { revision: string; accept: Set<string>; browserVersion?: string }>;

/** Build an expected-revision map like `readExpectedBrowserRevisions` returns. */
function expected(entries: Record<string, { revision: string; accept?: string[] }>): Expected {
  const map: Expected = new Map();
  for (const [base, { revision, accept }] of Object.entries(entries)) {
    map.set(base, { revision, accept: new Set(accept ?? [revision]) });
  }
  return map;
}

/** Build an installed map like `readInstalledBrowsers` returns. */
function installed(entries: Record<string, string[]>): Map<string, Set<string>> {
  return new Map(Object.entries(entries).map(([base, revs]) => [base, new Set(revs)]));
}

describe('findStaleBrowsers', () => {
  it('reports nothing when the required revision is present', () => {
    const stale = findStaleBrowsers(
      expected({ chromium: { revision: '1234' }, chromium_headless_shell: { revision: '1234' } }),
      installed({ chromium: ['1234'], chromium_headless_shell: ['1234'] }),
    );
    expect(stale).toEqual([]);
  });

  it('ignores a leftover old build when the required one is also present', () => {
    // The exact scenario after `1.61 → 1.62`: 1217 lingers, 1234 is what matters.
    const stale = findStaleBrowsers(
      expected({ chromium: { revision: '1234' } }),
      installed({ chromium: ['1217', '1234'] }),
    );
    expect(stale).toEqual([]);
  });

  it('flags a browser present ONLY at an old revision as stale', () => {
    const stale = findStaleBrowsers(
      expected({ chromium: { revision: '1234' } }),
      installed({ chromium: ['1217'] }),
    );
    expect(stale).toEqual([{ base: 'chromium', have: ['1217'], need: '1234' }]);
  });

  it('does not fault a browser the user never installed', () => {
    // Only chromium on disk; firefox/webkit are expected-by-default but absent.
    const stale = findStaleBrowsers(
      expected({
        chromium: { revision: '1234' },
        firefox: { revision: '1538' },
        webkit: { revision: '2336' },
      }),
      installed({ chromium: ['1234'] }),
    );
    expect(stale).toEqual([]);
  });

  it('ignores installed folders that are not tracked (winldd)', () => {
    const stale = findStaleBrowsers(
      expected({ chromium: { revision: '1234' } }),
      installed({ chromium: ['1234'], winldd: ['1007'] }),
    );
    expect(stale).toEqual([]);
  });

  it('accepts any per-OS override revision for webkit (not just the base)', () => {
    // webkit ships `revisionOverrides`, so an older build on some targets is OK.
    const stale = findStaleBrowsers(
      expected({ webkit: { revision: '2336', accept: ['2336', '2251', '2092'] } }),
      installed({ webkit: ['2092'] }),
    );
    expect(stale).toEqual([]);
  });
});
