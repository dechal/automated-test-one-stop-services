import type { ScheduleEntry } from '@hub/shared';
import { describe, expect, it } from 'vitest';
import { openLocalDb } from '../local-db.js';

/**
 * Regression guard for the P1 custom-schedule command gap: a typed `command`
 * (script/args/cwd) had no SQLite column, so it was dropped on write and read
 * back as `undefined`, silently degrading a custom schedule into a broken tool
 * run after a Hub restart. We assert three states explicitly:
 *   - full command (script + args + cwd) survives write→read
 *   - optional args/cwd omitted read back `undefined` while `script` survives
 *   - a tool schedule (no command) reads back `command: undefined` (unchanged)
 */

const baseReq = {
  tool: 'playwright' as const,
  type: 'web',
  project: 'demo',
  mode: 'local' as const,
};

describe('custom schedule command round-trip (script/args/cwd)', () => {
  it('persists a full command and omits an absent one', () => {
    const db = openLocalDb(':memory:');
    const schedules: ScheduleEntry[] = [
      {
        id: 's-full',
        name: 'seed',
        cron: '0 0 * * *',
        config: { ...baseReq },
        command: { script: 'node scripts/seed.mjs', args: '--force', cwd: 'tools/playwright' },
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 's-script-only',
        name: 'lint',
        cron: '0 1 * * *',
        config: { ...baseReq },
        command: { script: 'task lint' },
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 's-tool',
        name: 'nightly',
        cron: '0 2 * * *',
        config: { ...baseReq },
        enabled: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    db.writeCollection('schedules.json', schedules);
    const back = db.readCollection<ScheduleEntry>('schedules.json');

    const full = back.find((s) => s.id === 's-full');
    expect(full?.command).toEqual({
      script: 'node scripts/seed.mjs',
      args: '--force',
      cwd: 'tools/playwright',
    });

    const scriptOnly = back.find((s) => s.id === 's-script-only');
    expect(scriptOnly?.command?.script).toBe('task lint');
    expect(scriptOnly?.command?.args).toBeUndefined();
    expect(scriptOnly?.command?.cwd).toBeUndefined();

    const tool = back.find((s) => s.id === 's-tool');
    expect(tool?.command).toBeUndefined();
  });
});
