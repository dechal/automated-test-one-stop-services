import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sweepOutputs } from '../outputs-retention.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 28, 12, 0, 0).getTime();

let tmp: string | null = null;

function makeRun(root: string, rel: string, marker?: string): string {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), 'x');
  if (marker) fs.writeFileSync(path.join(dir, marker), '');
  return dir;
}

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('sweepOutputs (central retention runner)', () => {
  it('removes expired runs and keeps .lock / .favorite runs and fresh runs', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-retention-'));
    const old = makeRun(tmp, 'tool/p/success/2026-08-01/10-00-00');
    const locked = makeRun(tmp, 'tool/p/success/2026-08-01/11-00-00', '.lock');
    const fav = makeRun(tmp, 'tool/p/error/2026-08-02/09-00-00', '.favorite');
    const fresh = makeRun(tmp, 'tool/p/success/2026-10-27/10-00-00');

    const result = await sweepOutputs(30, tmp, NOW);

    expect(result.removed).toEqual([old]);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(locked)).toBe(true);
    expect(fs.existsSync(fav)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('deletes nothing when the plan is empty', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-retention-'));
    const fresh = makeRun(tmp, 'tool/p/success/2026-10-27/10-00-00');
    const result = await sweepOutputs(30, tmp, NOW - DAY_MS);
    expect(result).toEqual({ planned: 0, removed: [], failed: [] });
    expect(fs.existsSync(fresh)).toBe(true);
  });
});
