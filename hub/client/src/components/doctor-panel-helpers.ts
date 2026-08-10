import type { DoctorCategory, DoctorCheck, DoctorReport } from '@hub/shared';
import { translate } from '~/i18n/index.js';

/**
 * Pure, framework-free helpers backing {@link DoctorPanel}.
 *
 * These functions are intentionally free of React/Mantine imports so they can
 * be unit- and property-tested in isolation. The component composes them with
 * rendering.
 */

/** The three Doctor categories, in the order they should be rendered. */
export const DOCTOR_CATEGORY_ORDER: readonly DoctorCategory[] = [
  'required-install',
  'optional-install',
  'optional-process',
] as const;

/** Checks partitioned by their {@link DoctorCategory}. */
export type DoctorCategoryGroups = Record<DoctorCategory, DoctorCheck[]>;

/**
 * Partition checks into the three fixed category groups.
 *
 * The partition is lossless: every input check lands in exactly one group and
 * no check is dropped or duplicated, so the summed group sizes equal the input
 * length. Relative order within a group is preserved.
 */
export function groupByCategory(checks: DoctorCheck[]): DoctorCategoryGroups {
  const groups: DoctorCategoryGroups = {
    'required-install': [],
    'optional-install': [],
    'optional-process': [],
  };
  for (const check of checks) {
    groups[check.category].push(check);
  }
  return groups;
}

/**
 * Whether a category group's header should be rendered.
 *
 * Headers are shown only for groups with at least one member; empty groups are
 * hidden entirely.
 */
export function shouldShowGroup(checks: DoctorCheck[]): boolean {
  return checks.length > 0;
}

/**
 * Whether the panel should auto-expand on the first ready report.
 *
 * True iff at least one check in the `required-install` or `optional-install`
 * group has `ok === false`; otherwise the panel stays collapsed.
 */
export function shouldAutoExpand(report: DoctorReport): boolean {
  return report.checks.some(
    (check) =>
      !check.ok &&
      // Do not tear the panel open over a probe that merely ran out of time.
      !check.unverified &&
      (check.category === 'required-install' || check.category === 'optional-install'),
  );
}

/** Summary badge derived from the `required-install` group only. */
export interface SummaryBadge {
  /** Display text: `"X/Y OK"` when all required pass, else `"Action required"`. */
  text: string;
  /** `true` when every required-install check passes (green badge). */
  ok: boolean;
}

/**
 * Compute the collapsed-state summary badge from the `required-install` group
 * only — `optional-install`/`optional-process` checks never affect it.
 *
 * When every required-install check passes the badge reads `"X/Y OK"` where X
 * is the count of passing required-install checks and Y is the total number of
 * required-install checks (green). When at least one required-install check
 * fails the badge reads `"Action required"`.
 */
export function summaryBadge(checks: DoctorCheck[]): SummaryBadge {
  const required = checks.filter((check) => check.category === 'required-install');
  // An unverified probe (timed out under load) is not a failure — counting it as
  // one made the badge shout "Action required" over an installed tool. It is
  // excluded from the denominator too, so the ratio stays honest about what was
  // actually measured.
  const measured = required.filter((check) => !check.unverified);
  const okCount = measured.filter((check) => check.ok).length;
  const allOk = okCount === measured.length;
  return allOk
    ? { text: `${okCount}/${measured.length} OK`, ok: true }
    : { text: 'Action required', ok: false };
}

/** Convenience accessor for {@link summaryBadge} text only. */
export function summaryBadgeText(checks: DoctorCheck[]): string {
  return summaryBadge(checks).text;
}

/**
 * Map a doctor check name to the tool id whose `setup` task provisions it, or
 * `undefined` when the check has no provision action. Only the
 * folder-presence-gated tool checks are provisionable:
 * `playwright-browsers` (browser binaries) → `playwright`, `k6` (binary) → `k6`.
 * Generic environment checks (node, git, docker, …) return `undefined`, so no
 * Provision button is offered for them.
 */
export function provisionTargetFor(checkName: string): string | undefined {
  if (checkName === 'playwright-browsers') return 'playwright';
  if (checkName === 'k6') return 'k6';
  return undefined;
}

/** One actionable remediation step rendered in the "How to fix" block. */
export interface ProvisionGuidanceStep {
  /** Short imperative title. */
  readonly title: string;
  /** One-line detail — references env-key NAMES only, never a URL or secret. */
  readonly detail: string;
}

/**
 * Actionable guidance shown when (re-)provisioning a tool fails, ordered for a
 * workstation that pulls from the public CDN with NO internal mirror:
 * retry → manual archive → proxy → (optional) mirror. References env-key names
 * only and never embeds a CDN URL or secret, and never claims a mirror exists —
 * the mirror step is explicitly conditional ("if your organisation provides
 * one"). Playwright browsers are archive-provisioned so the full list applies;
 * any other tool gets the generic retry step only.
 */
export function provisionGuidance(toolId: string): readonly ProvisionGuidanceStep[] {
  const retry: ProvisionGuidanceStep = {
    title: translate('common.retry'),
    detail: translate('doctor.retryDetail'),
  };
  if (toolId !== 'playwright') return [retry];
  return [
    retry,
    {
      title: translate('doctor.manualBrowserInstall'),
      detail: translate('doctor.manualBrowserDetail'),
    },
    {
      title: translate('doctor.behindProxy'),
      detail: translate('doctor.behindProxyDetail'),
    },
    {
      title: translate('doctor.internalMirror'),
      detail: translate('doctor.internalMirrorDetail'),
    },
  ];
}
