import type { RunSummary } from '@hub/shared';
import type { ReactNode } from 'react';
import { TbAlertTriangle, TbCircleCheck, TbCircleX, TbClock, TbHelp } from 'react-icons/tb';
import type { TranslationKey } from '~/i18n/en';

/**
 * Shared helpers for rendering run/report statuses consistently across pages.
 *
 * Avoids each page redefining its own statusColor/statusIcon helpers and keeps
 * colour/icon mapping centralised so tweaks propagate everywhere.
 */

/** Mantine colour name for a run or report status. */
export function getStatusColor(status: string): string {
  switch (status) {
    case 'passed':
    case 'success':
      return 'green';
    case 'failed':
    case 'error':
      return 'red';
    case 'cancelled':
      return 'yellow';
    case 'running':
    case 'pending':
      return 'blue';
    default:
      return 'gray';
  }
}

/** Render a small leading icon matching the status colour. */
export function getStatusIcon(status: string, size = 14): ReactNode {
  switch (status) {
    case 'passed':
    case 'success':
      return <TbCircleCheck size={size} />;
    case 'failed':
    case 'error':
      return <TbCircleX size={size} />;
    case 'running':
    case 'pending':
      return <TbClock size={size} />;
    default:
      return <TbHelp size={size} />;
  }
}

/**
 * How a finished run/report should be *presented* — label, colour and icon.
 *
 * Why this exists: a report's stored `status` is only which output directory the
 * runner wrote into (`success/` vs `error/`), i.e. its exit code. A Playwright
 * run with 7 of 32 tests failing exits non-zero, so it lands in `error/` — and
 * rendering that raw value badged every such row as `ERROR`. On a real page that
 * made 10 of 13 rows identically red, which hid the one case that matters: a run
 * that never produced a result at all (crash, bad config, empty selection).
 *
 * So the outcome is derived from the status AND the parsed counts:
 *
 * - tests ran, some failed  → "Tests failed", orange. Expected, actionable, and
 *   the pass-% column already quantifies it.
 * - tests ran, none failed  → "All passed", green.
 * - no counts + error       → "Run error", red + a warning icon. The rare one.
 *
 * Colour is never the only signal (label + icon differ too), per the UX
 * checklist's accessibility rule.
 */
export interface RunOutcome {
  labelKey: TranslationKey;
  color: string;
  icon: ReactNode;
  /** True for the genuine "the run itself broke" case, which is worth emphasis. */
  emphasise: boolean;
}

export function runOutcome(
  status: string,
  summary: RunSummary | null | undefined,
  size = 14,
): RunOutcome {
  const total = summary ? summary.passed + summary.failed + (summary.skipped ?? 0) : 0;
  const ranSomething = total > 0;

  if (status === 'running' || status === 'pending') {
    return {
      labelKey: 'common.running',
      color: 'blue',
      icon: <TbClock size={size} />,
      emphasise: false,
    };
  }
  if (status === 'cancelled') {
    return {
      labelKey: 'status.cancelled',
      color: 'yellow',
      icon: <TbCircleX size={size} />,
      emphasise: false,
    };
  }
  if (ranSomething && summary && summary.failed > 0) {
    return {
      labelKey: 'status.testsFailed',
      color: 'orange',
      icon: <TbCircleX size={size} />,
      emphasise: false,
    };
  }
  if (ranSomething) {
    return {
      labelKey: 'status.allPassed',
      color: 'green',
      icon: <TbCircleCheck size={size} />,
      emphasise: false,
    };
  }
  // No counts to go on: fall back to the coarse status.
  if (status === 'error' || status === 'failed') {
    return {
      labelKey: 'status.runError',
      color: 'red',
      icon: <TbAlertTriangle size={size} />,
      emphasise: true,
    };
  }
  if (status === 'success' || status === 'passed') {
    return {
      labelKey: 'status.allPassed',
      color: 'green',
      icon: <TbCircleCheck size={size} />,
      emphasise: false,
    };
  }
  return {
    labelKey: 'status.unknown',
    color: 'gray',
    icon: <TbHelp size={size} />,
    emphasise: false,
  };
}
