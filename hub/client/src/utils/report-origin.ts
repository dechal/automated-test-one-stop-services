import type { ReportEntry } from '@hub/shared';
import { runOutcome } from '~/utils/run-status.js';

export function isHubOrigin(
  r: Pick<
    ReportEntry,
    'summary' | 'durationMs' | 'runTag' | 'runMode' | 'environment' | 'envProfileName'
  >,
): boolean {
  return (
    r.summary !== undefined ||
    r.durationMs !== undefined ||
    r.runTag !== undefined ||
    r.runMode !== undefined ||
    r.environment !== undefined ||
    r.envProfileName !== undefined
  );
}

export function isCrashReport(r: Pick<ReportEntry, 'status' | 'summary'>): boolean {
  if (r.status !== 'error') return false;
  const outcome = runOutcome(r.status, r.summary);
  return outcome.labelKey === 'status.runError' && outcome.emphasise === true;
}
