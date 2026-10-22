import type { RunSummary } from '@hub/shared';
import { describe, expect, it } from 'vitest';
import { runOutcome, statusLabelKey } from '../run-status';

/**
 * `runOutcome` decides the status badge from (status, summary). The case that
 * needed pinning: counters can be ALL GREEN while the run itself failed — a k6
 * threshold breach exits 99 with every check passing. Before 2026-08-21 that was
 * badged green "All passed".
 */
describe('runOutcome', () => {
  const summary = (passed: number, failed: number): RunSummary => ({ passed, failed });

  it('prefers the failed process outcome over all-green counters', () => {
    expect(runOutcome('failed', summary(46, 0)).labelKey).toBe('status.testsFailed');
    expect(runOutcome('error', summary(46, 0)).labelKey).toBe('status.testsFailed');
  });

  it('badges a genuinely clean run green', () => {
    expect(runOutcome('passed', summary(46, 0)).labelKey).toBe('status.allPassed');
  });

  it('badges counted failures as failed, not as a run error', () => {
    const outcome = runOutcome('failed', summary(198, 9));
    expect(outcome.labelKey).toBe('status.testsFailed');
    expect(outcome.emphasise).toBe(false);
  });

  it('keeps "Run error" for a failure with no counts at all', () => {
    const outcome = runOutcome('failed', null);
    expect(outcome.labelKey).toBe('status.runError');
    expect(outcome.emphasise).toBe(true);
  });

  it('reports in-flight and cancelled runs from the status alone', () => {
    expect(runOutcome('running', null).labelKey).toBe('common.running');
    expect(runOutcome('cancelled', summary(1, 0)).labelKey).toBe('status.cancelled');
  });
});

describe('statusLabelKey', () => {
  it('maps passed and success to the passed label', () => {
    expect(statusLabelKey('passed')).toBe('status.allPassed');
    expect(statusLabelKey('success')).toBe('status.allPassed');
  });

  it('maps failed to the failed label', () => {
    expect(statusLabelKey('failed')).toBe('status.testsFailed');
  });

  it('maps error to the run-error label', () => {
    expect(statusLabelKey('error')).toBe('status.runError');
  });

  it('maps cancelled to the cancelled label', () => {
    expect(statusLabelKey('cancelled')).toBe('status.cancelled');
  });

  it('maps running and pending to the running label', () => {
    expect(statusLabelKey('running')).toBe('common.running');
    expect(statusLabelKey('pending')).toBe('common.running');
  });

  it('maps anything else to the unknown label', () => {
    expect(statusLabelKey('skipped')).toBe('status.unknown');
    expect(statusLabelKey('')).toBe('status.unknown');
  });
});
