export type DoctorCategory = 'required-install' | 'optional-install' | 'optional-process';

/**
 * Kind of one-click installer the Hub can run for a failing check, surfaced as
 * an in-panel button. Currently only `'python'` (retroactive `uv python install`
 * when the toolchain was skipped during setup). Extend the union to add more.
 */
export type DoctorInstallKind = 'python';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  version?: string;
  hint?: string;
  category: DoctorCategory;
  /**
   * When set on a failing check, the Doctor panel offers a one-click installer
   * button (e.g. `'python'` → `POST /api/doctor/install-python`). Absent on
   * checks that have no Hub-driven install path.
   */
  install?: DoctorInstallKind;
  /**
   * The probe did not finish in time, so presence is UNKNOWN — not absent.
   *
   * A doctor probe shells out, and the sweep launches ~14 of them at once, so
   * under load (a concurrent build, a test run, antivirus) a probe for an
   * installed tool can exceed its timeout. Reporting that as a failure told
   * users to install software they already had, so it is its own state:
   * `ok` stays false, but nothing treats it as a verdict.
   */
  unverified?: boolean;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  overallOk: boolean;
  credentialsOk: boolean;
}

/**
 * Result of `POST /api/doctor/install-python` — a retroactive install of the
 * Python toolchain skipped during setup. `ok` is `true` once the interpreter is
 * installed (the state the `python` doctor check verifies); `message` carries a
 * non-fatal warning (e.g. the follow-up `uv sync` failed), and `error` carries
 * the cause when the interpreter install itself failed.
 */
export interface PythonInstallResult {
  readonly ok: boolean;
  readonly version: string;
  readonly message?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

// ============================================================================
// Tool run requirements + install ordering
// ============================================================================
// A tool can only RUN when the doctor checks it depends on all pass, and an
// installable check (e.g. python) can only be installed once its prerequisites
// pass (e.g. uv). These pure helpers back the Run-button gate (RunSession) and
// the ordered install gate (DoctorPanel), so the Hub can block a doomed run/
// install up-front and tell the user exactly what is missing — no CLI needed.

/** Minimal tool shape needed to derive its runtime requirements (a subset of
 *  {@link ToolView}). */
export interface ToolRequirementInput {
  readonly id: string;
  readonly runtime: 'node' | 'python' | 'binary';
  readonly packageManager: 'pnpm' | 'uv' | 'none';
}

/**
 * Doctor check names a tool needs before it can run, derived from its runtime +
 * package manager plus tool-specific runtime assets:
 *   - pnpm  → node + pnpm         (Playwright)
 *   - uv    → uv                  (Robot Framework)
 *   - python runtime → python     (Robot Framework)
 *   - binary runtime → the tool's own check, e.g. k6 → `k6`
 *   - playwright → its browsers
 * Deriving from the manifest keeps new tools working without a hardcoded table
 * (the one `playwright` special-case is its browser cache, which is genuinely
 * Playwright-specific).
 */
export function toolRequiredChecks(tool: ToolRequirementInput): string[] {
  const checks = new Set<string>();
  if (tool.packageManager === 'pnpm') {
    checks.add('node');
    checks.add('pnpm');
  }
  if (tool.packageManager === 'uv') checks.add('uv');
  if (tool.runtime === 'python') checks.add('python');
  if (tool.runtime === 'binary') checks.add(tool.id);
  if (tool.id === 'playwright') checks.add('playwright-browsers');
  return [...checks];
}

/**
 * Install prerequisites between doctor checks (ordered install gating): a check
 * cannot be installed until every prerequisite check passes. Python is installed
 * *by* uv, so `python` requires `uv`; the Playwright browsers are fetched via
 * `pnpm exec`, so they require node + pnpm.
 */
export const CHECK_PREREQUISITES: Readonly<Record<string, readonly string[]>> = {
  python: ['uv'],
  'playwright-browsers': ['node', 'pnpm'],
};

/** True when a check named `name` is present and passing in `checks`. */
function checkPasses(name: string, checks: readonly DoctorCheck[]): boolean {
  return checks.some((c) => c.name === name && c.ok);
}

/** Prerequisite check names that are NOT currently passing (empty = ready to
 *  install). Drives the ordered install gate in the Doctor panel. */
export function missingPrerequisites(checkName: string, checks: readonly DoctorCheck[]): string[] {
  return (CHECK_PREREQUISITES[checkName] ?? []).filter((p) => !checkPasses(p, checks));
}

/** Required check names for a tool that are missing/failing (empty = ready to
 *  run). An absent required check counts as missing (unverified → blocked). */
export function missingChecksForTool(
  tool: ToolRequirementInput,
  checks: readonly DoctorCheck[],
): string[] {
  return toolRequiredChecks(tool).filter((name) => !checkPasses(name, checks));
}
