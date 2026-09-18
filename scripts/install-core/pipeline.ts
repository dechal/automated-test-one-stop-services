// scripts/install-core/pipeline.ts
//
// The headless install pipeline both the Hub Post_Install_Hook and the
// headless CLI call, so they run the SAME deps + setup by construction.
//
// The pipeline is pure: it drives an injected `InstallEffects` port set and the
// SHARED setup-planner decision logic (`planToolSetup` / `aggregateSetupFailures`
// from `scripts/manifests/setup-planner.ts`), so the "which deps / which setup /
// how failures are reported" decision is never duplicated. Injecting the
// effects keeps Fastify / hub-config / scanner / `withResync` out of install-core
// (those stay Hub-server concerns) and lets its property test assert ZERO side effects
// on invalid input with a spy.

import {
  aggregateSetupFailures,
  planToolSetup,
  type ToolSetupFacts,
  type ToolSetupOutcome,
} from '../manifests/setup-planner.js';
import type { ToolPackageManager } from './invocation.js';
import { isSafeGitRef, isSafeGitUrl, isSafeToolId } from './validation.js';

/** The stage a CLI/hook install reached; set as `failedStage` on failure. */
export type InstallStage = 'validate' | 'clone' | 'deps' | 'setup';

/** Where the tool comes from: a registry git URL to clone, or an already-present folder. */
export type InstallSource =
  | { readonly kind: 'registry'; readonly gitUrl: string; readonly ref: string }
  | { readonly kind: 'local' };

/** A single headless install request. */
export interface InstallRequest {
  readonly id: string;
  readonly source: InstallSource;
}

/** The pipeline result. `failedStage`/`message` are set only when `ok` is false. */
export interface InstallResult {
  readonly ok: boolean;
  readonly failedStage?: InstallStage;
  readonly message?: string;
}

/**
 * Ports the pipeline drives. Real implementations live in `effects.ts`
 * (child_process spawn + git + folder-presence scan); a spy implements them in
 * tests. Every effect runs ONLY after validation has passed.
 *
 * `cloneRegistry` and `installDeps` throw on failure (mapped to a `failedStage`);
 * `runSetup` returns its outcome so a non-zero exit is *reported* rather than
 * thrown, matching the planner's non-fatal tool-setup model.
 */
export interface InstallEffects {
  cloneRegistry(input: { id: string; gitUrl: string; ref: string }): void;
  gatherFacts(id: string): ToolSetupFacts | undefined;
  installDeps(input: { id: string; manager: ToolPackageManager }): void;
  runSetup(input: { id: string }): ToolSetupOutcome;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run the headless install pipeline: validate → (registry) clone → install deps
 * → run the tool's `setup` task.
 *
 * the `validate` stage gates ALL side effects.
 * No `effects` method is touched until the id (and, for a registry install, the
 * git URL) pass their safe patterns — rejection always precedes any side effect.
 */
export function runInstallPipeline(
  request: InstallRequest,
  effects: InstallEffects,
): InstallResult {
  const { id, source } = request;

  // ── Stage 'validate' — the side-effect gate ──────────────────
  if (!isSafeToolId(id)) {
    return {
      ok: false,
      failedStage: 'validate',
      message: `invalid tool id: ${JSON.stringify(id)}`,
    };
  }
  if (source.kind === 'registry' && !isSafeGitUrl(source.gitUrl)) {
    return { ok: false, failedStage: 'validate', message: `invalid git URL for tool '${id}'` };
  }
  if (source.kind === 'registry' && !isSafeGitRef(source.ref)) {
    return { ok: false, failedStage: 'validate', message: `invalid git ref for tool '${id}'` };
  }

  // ── Stage 'clone' (registry source only) ───────────────────────────────────
  if (source.kind === 'registry') {
    try {
      effects.cloneRegistry({ id, gitUrl: source.gitUrl, ref: source.ref });
    } catch (err) {
      return { ok: false, failedStage: 'clone', message: errMessage(err) };
    }
  }

  // ── Decide deps + setup via the SHARED planner (no duplicated logic) ─
  const facts = effects.gatherFacts(id);
  const plan = planToolSetup(facts ? [facts] : []);
  const step = plan.steps[0];

  // ── Stage 'deps' ───────────────────────────────────────────────────────────
  try {
    if (step?.installPnpm) effects.installDeps({ id, manager: 'pnpm' });
    if (plan.runUvSync) effects.installDeps({ id, manager: 'uv' });
  } catch (err) {
    return { ok: false, failedStage: 'deps', message: errMessage(err) };
  }

  // ── Stage 'setup' — invoke the tool's setup task iff it defines one ──
  if (step?.runSetup) {
    const report = aggregateSetupFailures([effects.runSetup({ id })]);
    if (!report.ok) {
      return { ok: false, failedStage: 'setup', message: report.message };
    }
  }

  return { ok: true };
}
