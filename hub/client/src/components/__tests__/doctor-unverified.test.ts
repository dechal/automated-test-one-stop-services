import type { DoctorCheck, DoctorReport } from '@hub/shared';
import { describe, expect, it } from 'vitest';
import { shouldAutoExpand, summaryBadge } from '../doctor-panel-helpers.js';

/**
 * A timed-out probe must never read as a missing tool. These pin the three places
 * that used to turn "could not verify" into "ACTION REQUIRED".
 */
const required = (over: Partial<DoctorCheck>): DoctorCheck => ({
  name: 'pnpm',
  ok: false,
  category: 'required-install',
  ...over,
});

const report = (checks: DoctorCheck[]): DoctorReport => ({
  checks,
  overallOk: false,
  credentialsOk: true,
});

describe('an unverified check is not a failure', () => {
  it('summaryBadge stays OK and excludes it from the ratio', () => {
    const badge = summaryBadge([
      required({ name: 'node', ok: true }),
      required({ name: 'pnpm', unverified: true }),
    ]);

    expect(badge.ok).toBe(true);
    expect(badge.text).toBe('1/1 OK');
  });

  it('summaryBadge still reports a genuine miss', () => {
    const badge = summaryBadge([
      required({ name: 'node', ok: true }),
      required({ name: 'pnpm' }),
      required({ name: 'k6', unverified: true }),
    ]);

    expect(badge.ok).toBe(false);
    expect(badge.text).toBe('Action required');
  });

  it('does not auto-expand the panel', () => {
    expect(shouldAutoExpand(report([required({ unverified: true })]))).toBe(false);
  });

  it('still auto-expands for a genuine miss', () => {
    expect(shouldAutoExpand(report([required({})]))).toBe(true);
  });
});
