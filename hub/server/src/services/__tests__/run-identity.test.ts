import { describe, expect, it } from 'vitest';
import { nextOutputStamp, resolveRunTimeoutMs } from '../runner.js';

describe('nextOutputStamp — the run dictates its own output directory', () => {
  it('formats the stamp exactly as the Taskfile would (date/HH-MM-SS)', () => {
    const at = new Date(2026, 8, 9, 7, 5, 3);
    expect(nextOutputStamp(at, new Set())).toBe('2026-09-09/07-05-03');
  });

  it('bumps by one second when a run already in flight holds that stamp', () => {
    const at = new Date(2026, 8, 9, 7, 5, 3);
    expect(nextOutputStamp(at, new Set(['2026-09-09/07-05-03']))).toBe('2026-09-09/07-05-04');
  });

  it('keeps bumping past several taken stamps so no two runs can share a directory', () => {
    const at = new Date(2026, 8, 9, 7, 5, 3);
    const taken = new Set(['2026-09-09/07-05-03', '2026-09-09/07-05-04', '2026-09-09/07-05-05']);
    expect(nextOutputStamp(at, taken)).toBe('2026-09-09/07-05-06');
  });

  it('rolls over the minute boundary rather than emitting second 60', () => {
    const at = new Date(2026, 8, 9, 7, 5, 59);
    expect(nextOutputStamp(at, new Set(['2026-09-09/07-05-59']))).toBe('2026-09-09/07-06-00');
  });
});

describe('resolveRunTimeoutMs', () => {
  it('defaults to 4 hours when unset or blank', () => {
    expect(resolveRunTimeoutMs(undefined)).toBe(4 * 60 * 60 * 1000);
    expect(resolveRunTimeoutMs('   ')).toBe(4 * 60 * 60 * 1000);
  });

  it('accepts an explicit override', () => {
    expect(resolveRunTimeoutMs('60000')).toBe(60_000);
  });

  it('treats 0 as "no timeout" rather than "cancel immediately"', () => {
    expect(resolveRunTimeoutMs('0')).toBe(0);
  });

  it('falls back to the default on junk or a negative value', () => {
    expect(resolveRunTimeoutMs('soon')).toBe(4 * 60 * 60 * 1000);
    expect(resolveRunTimeoutMs('-5')).toBe(4 * 60 * 60 * 1000);
  });
});
