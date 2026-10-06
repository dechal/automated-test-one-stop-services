import type { EnvProfile } from '@hub/shared';
import { describe, expect, it } from 'vitest';
import {
  buildEnvOptions,
  ENV_CURRENT,
  ENV_OPTIONS,
  envColor,
  resolveDefaultEnv,
} from '../env-options';

function profile(id: string, name = id): EnvProfile {
  return {
    id,
    name,
    environment: 'dev',
    tool: 'playwright' as EnvProfile['tool'],
    type: 'web',
    project: 'demo',
    entries: {},
    createdAt: '',
    updatedAt: '',
  };
}

describe('ENV_OPTIONS', () => {
  it('still includes the custom option', () => {
    expect(ENV_OPTIONS.map((o) => o.value)).toContain('custom');
  });
});

describe('envColor', () => {
  it('maps known environments and falls through to gray', () => {
    expect(envColor('dev')).toBe('blue');
    expect(envColor('staging')).toBe('yellow');
    expect(envColor('prod')).toBe('red');
    expect(envColor('custom')).toBe('gray');
  });
});

describe('buildEnvOptions', () => {
  it('puts the __current__ sentinel first', () => {
    const opts = buildEnvOptions([profile('a'), profile('b')], 'Current');
    expect(opts[0]).toEqual({ value: ENV_CURRENT, label: 'Current' });
    expect(opts.map((o) => o.value)).toEqual([ENV_CURRENT, 'a', 'b']);
  });

  it('handles an empty / undefined profile list', () => {
    expect(buildEnvOptions(undefined, 'Current')).toEqual([
      { value: ENV_CURRENT, label: 'Current' },
    ]);
    expect(buildEnvOptions([], 'Current')).toHaveLength(1);
  });
});

describe('resolveDefaultEnv', () => {
  it('returns the default id when the profile is still present', () => {
    expect(resolveDefaultEnv('b', [profile('a'), profile('b')])).toBe('b');
  });

  it('falls back to the sentinel when the default is absent or null', () => {
    expect(resolveDefaultEnv('gone', [profile('a')])).toBe(ENV_CURRENT);
    expect(resolveDefaultEnv(null, [profile('a')])).toBe(ENV_CURRENT);
    expect(resolveDefaultEnv(undefined, undefined)).toBe(ENV_CURRENT);
  });
});
