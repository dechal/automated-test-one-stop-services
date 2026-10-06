import type { EnvProfile } from '@hub/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDb } from '../db.js';
import { envProfileService } from '../env-profiles.js';
import { openLocalDb } from '../local-db.js';

/**
 * Service-level guards for the env-profile foundation (FEAT-001):
 *   - validate(): key-sync against the template (missing warns, extra gates)
 *   - setDefault(): the "one default per (tool,type,project)" invariant
 *   - persistence round-trip: `isDefault` / `allowOutsideTemplate` survive a
 *     writeCollection → readCollection cycle (the direct guard for the
 *     "new scalar with no SQLite column vanishes silently" trap)
 *
 * `getTemplate` reads a project's `.env.template` from the real TOOLS_DIR, which
 * is a git-ignored tool repo absent in CI — so it is spied per test to feed a
 * controlled template and keep every case hermetic.
 */

const base = {
  environment: 'dev',
  tool: 'playwright' as const,
  type: 'web',
  project: 'demo',
};

function makeProfile(over: Partial<EnvProfile>): EnvProfile {
  return {
    id: 'p1',
    name: 'profile',
    ...base,
    entries: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  setDb(openLocalDb(':memory:'));
});

afterEach(() => {
  vi.restoreAllMocks();
  setDb(undefined);
});

describe('envProfileService.validate', () => {
  it('reports hasTemplate false and skips key-sync when the template is empty', () => {
    vi.spyOn(envProfileService, 'getTemplate').mockReturnValue({});
    const result = envProfileService.validate(
      makeProfile({ entries: { ANY_KEY: 'v', OTHER: 'x' } }),
    );
    expect(result).toEqual({ missingKeys: [], extraKeys: [], hasTemplate: false });
  });

  it('flags template keys the profile is missing as a non-blocking warning', () => {
    vi.spyOn(envProfileService, 'getTemplate').mockReturnValue({ A: '', B: '', C: '' });
    const result = envProfileService.validate(makeProfile({ entries: { A: '1' } }));
    expect(result.hasTemplate).toBe(true);
    expect(result.missingKeys.sort()).toEqual(['B', 'C']);
    expect(result.extraKeys).toEqual([]);
  });

  it('flags profile keys not in the template as extraKeys', () => {
    vi.spyOn(envProfileService, 'getTemplate').mockReturnValue({ A: '' });
    const result = envProfileService.validate(makeProfile({ entries: { A: '1', EXTRA: '2' } }));
    expect(result.extraKeys).toEqual(['EXTRA']);
    expect(result.missingKeys).toEqual([]);
  });

  it('reports both missing and extra when the profile and template diverge', () => {
    vi.spyOn(envProfileService, 'getTemplate').mockReturnValue({ A: '', B: '' });
    const result = envProfileService.validate(makeProfile({ entries: { A: '1', EXTRA: '2' } }));
    expect(result.missingKeys).toEqual(['B']);
    expect(result.extraKeys).toEqual(['EXTRA']);
  });
});

describe('envProfileService.setDefault', () => {
  it('leaves exactly one default when a second default is set on the same project', () => {
    const first = envProfileService.create(makeProfile({ id: 'ignored', name: 'first' }));
    const second = envProfileService.create(makeProfile({ id: 'ignored', name: 'second' }));

    envProfileService.setDefault(first.id);
    envProfileService.setDefault(second.id);

    const forProject = envProfileService.getByProject(base.tool, base.type, base.project);
    const defaults = forProject.filter((p) => p.isDefault === true);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.id).toBe(second.id);
    expect(envProfileService.getDefault(base.tool, base.type, base.project)).toBe(second.id);
  });

  it('does not clear a default on a different (tool,type,project)', () => {
    const a = envProfileService.create(makeProfile({ name: 'a', project: 'alpha' }));
    const b = envProfileService.create(makeProfile({ name: 'b', project: 'beta' }));

    envProfileService.setDefault(a.id);
    envProfileService.setDefault(b.id);

    expect(envProfileService.getDefault(base.tool, base.type, 'alpha')).toBe(a.id);
    expect(envProfileService.getDefault(base.tool, base.type, 'beta')).toBe(b.id);
  });

  it('returns null for an unknown id', () => {
    expect(envProfileService.setDefault('nope')).toBeNull();
  });
});

describe('EnvProfile persistence round-trip (isDefault / allowOutsideTemplate)', () => {
  it('writes both scalars via writeCollection and reads them back as true', () => {
    const db = openLocalDb(':memory:');
    const profile = makeProfile({
      id: 'rt1',
      entries: { A: '1' },
      isDefault: true,
      allowOutsideTemplate: true,
    });
    db.writeCollection('env-profiles.json', [profile]);

    const back = db.readCollection<EnvProfile>('env-profiles.json');
    expect(back).toHaveLength(1);
    expect(back[0]?.isDefault).toBe(true);
    expect(back[0]?.allowOutsideTemplate).toBe(true);
    expect(back[0]?.entries).toEqual({ A: '1' });
  });

  it('reads back absent flags as undefined, not false', () => {
    const db = openLocalDb(':memory:');
    db.writeCollection('env-profiles.json', [makeProfile({ id: 'rt2' })]);
    const back = db.readCollection<EnvProfile>('env-profiles.json');
    expect(back[0]?.isDefault).toBeUndefined();
    expect(back[0]?.allowOutsideTemplate).toBeUndefined();
  });

  it('round-trips a schedule envProfileId column', () => {
    const db = openLocalDb(':memory:');
    db.writeCollection('schedules.json', [
      {
        id: 's-env',
        name: 'with-env',
        cron: '0 0 * * *',
        config: { tool: 'playwright', type: 'web', project: 'demo', mode: 'local' },
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        envProfileId: 'prof-123',
      },
    ]);
    const back = db.readCollection<{ id: string; envProfileId?: string }>('schedules.json');
    expect(back.find((s) => s.id === 's-env')?.envProfileId).toBe('prof-123');
  });
});
