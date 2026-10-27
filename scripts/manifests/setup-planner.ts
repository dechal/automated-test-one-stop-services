// scripts/manifests/setup-planner.ts
//
// Setup_Task provisioning planner.
//
// The SINGLE source of the tool-provisioning decision logic. Both the root
// `Taskfile.yml` `setup` target (via the `plan` / `report` CLI below) and the
// `scripts/install-core/` library import these pure functions, so the
// "which tools get deps / which get a setup-task invocation / empty-set is
// clean / how failures are reported" decision is never duplicated.
//
// Discovery is folder-presence and reuses `discoverToolIds` (manifest-gated,
// sorted, excludes `.`-prefixed + `*-template-example`), so adding a tool folder
// that defines a `setup` task needs ZERO edits to this file or the root
// Taskfile.
//
// CLI usage (shelled out to by the root `setup` target, mirroring
// scripts/setup/setup-state.mjs):
// tsx scripts/manifests/setup-planner.ts plan [workspaceRoot]
// → prints a line-oriented provisioning plan the shell loop executes:
// PNPM <id> run `pnpm -C tools/<id> install --ignore-workspace`
// UVSYNC run a single root `uv sync` (only when a uv tool present)
// SETUP <id> run the tool's own `setup` task by taskfile path
// Dependency lines are emitted before SETUP lines so a tool's setup runs
// after its deps. An empty `tools/` set prints nothing (Core completes
// cleanly).
// tsx scripts/manifests/setup-planner.ts report <id> [<id> ...]
// → prints the aggregated failure report (names each failing tool id + a
// remediation hint). Always exits 0 — tool-setup failures are
// non-fatal to the Core install.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverToolIds } from './discover.js';
import { createManifestRegistry } from './index.js';

/**
 * Folder name shape a real tool id takes (mirrors the manifest `ToolId` pattern
 * used by the registry validator). Acts as a trust-boundary guard: only
 * pattern-matching folder names reach the shell command slot, so an exotic
 * directory name can never be interpolated into a `task --taskfile ...` call.
 */
export const SAFE_TOOL_ID = /^[a-z][a-z0-9-]*$/;

/**
 * Folder-presence facts about one discovered tool that drive its provisioning.
 * Gathered impurely by `gatherToolSetupFacts`; the planner core takes them as
 * input so its decision logic stays pure and property-testable.
 */
export interface ToolSetupFacts {
  readonly id: string;
  /** `tools/<id>/package.json` present → isolated `pnpm install --ignore-workspace`. */
  readonly hasPackageJson: boolean;
  /** `tools/<id>/pyproject.toml` present → contributes to the single root `uv sync`. */
  readonly isUvTool: boolean;
  /** `tools/<id>/Taskfile.yml` defines a top-level `setup:` task → invoke it. */
  readonly hasSetupTask: boolean;
}

/** Per-tool entry in the provisioning plan. */
export interface ToolSetupStep {
  readonly id: string;
  /** Install this tool's isolated pnpm deps (`--ignore-workspace`). */
  readonly installPnpm: boolean;
  /** Invoke this tool's own `setup` task. */
  readonly runSetup: boolean;
}

/** The provisioning plan for a `tools/` set. */
export interface SetupPlan {
  readonly steps: readonly ToolSetupStep[];
  /** Run a single root `uv sync` iff at least one present tool is a uv tool. */
  readonly runUvSync: boolean;
  /** No tools present → Core provisioning completes cleanly. */
  readonly isEmpty: boolean;
}

/**
 * Pure planner. Given the gathered per-tool facts, decide:
 * - which tools get an isolated pnpm install (`package.json` present),
 * - whether the single root `uv sync` runs (any uv tool present),
 * - which tools get their `setup` task invoked — iff they define one, so a tool
 * with no `setup` task still has its deps installed but the setup step is a
 * no-op,
 * - an empty facts set yields an empty plan, so Core finishes cleanly.
 *
 * No I/O: the root Taskfile loop (via the `plan` CLI) and `install-core` both
 * call THIS function, so the decision lives in one place. Adding or removing a
 * tool changes only the facts array, never this logic.
 */
export function planToolSetup(
  facts: readonly ToolSetupFacts[],
  enabledIds?: ReadonlySet<string>,
): SetupPlan {
  const active = enabledIds === undefined ? facts : facts.filter((f) => enabledIds.has(f.id));
  const steps: ToolSetupStep[] = active.map((f) => ({
    id: f.id,
    installPnpm: f.hasPackageJson,
    runSetup: f.hasSetupTask,
  }));
  return {
    steps,
    runUvSync: facts.some((f) => f.isUvTool),
    isEmpty: facts.length === 0,
  };
}

/** Outcome of attempting one tool's `setup` task. `exitCode === 0` ⇒ success. */
export interface ToolSetupOutcome {
  readonly id: string;
  readonly exitCode: number;
}

/** Aggregated report produced after every planned `setup` task has run. */
export interface SetupFailureReport {
  /** True when no tool's `setup` task exited non-zero. */
  readonly ok: boolean;
  readonly failedToolIds: readonly string[];
  /** Lines naming each failing tool id plus a remediation hint; empty when ok. */
  readonly message: string;
}

/**
 * The single remediation hint appended to every failure report. Kept as
 * one exported constant so the Taskfile loop (via the `report` CLI) and
 * `install-core` never reword it.
 */
export const SETUP_FAILURE_HINT =
  'run `task --taskfile tools/<id>/Taskfile.yml --dir tools/<id> setup` to see the ' +
  "tool's own error; verify the tool's setup prerequisites and, behind a proxy/mirror, " +
  'the HTTPS_PROXY and mirror-CA settings (TLS validation is not disabled).';

/**
 * Pure failure aggregator. Names every tool whose `setup` exited
 * non-zero and always includes at least one remediation hint. Tool-setup
 * failures are non-fatal to Core — the caller continues other tools and uses
 * this purely to report.
 */
export function aggregateSetupFailures(outcomes: readonly ToolSetupOutcome[]): SetupFailureReport {
  const failedToolIds = outcomes.filter((o) => o.exitCode !== 0).map((o) => o.id);
  if (failedToolIds.length === 0) {
    return { ok: true, failedToolIds: [], message: '' };
  }
  const named = failedToolIds.map((id) => `  - ${id}: tool setup task exited non-zero`).join('\n');
  const message = `Tool setup failed for: ${failedToolIds.join(', ')}\n${named}\nHint: ${SETUP_FAILURE_HINT}`;
  return { ok: false, failedToolIds, message };
}

/**
 * Does the tool's Taskfile define a top-level `setup:` task? Detected by a
 * two-space-indented `setup:` key — the repo's go-task convention (the same way
 * `android-decoupling.spec.ts` probes for `setup-android:`).
 *
 * Simplification: a regex over the raw Taskfile, not a YAML parse — no YAML dependency
 * and the convention is a fixed top-level `setup` task. Ceiling: a
 * `setup` task contributed via `includes:` or written with non-standard
 * indentation is not detected, so that tool gets deps-only (a safe no-op,
 * ). The blessed alternative — attempt the task and treat
 * go-task's "task does not exist" exit as a no-op — would cover that case at the
 * cost of distinguishing that exit from a genuine setup failure.
 */
export function taskfileHasSetupTask(taskfilePath: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(taskfilePath, 'utf8');
  } catch {
    return false;
  }
  return /\n {2}setup:/.test(text);
}

/**
 * Gather folder-presence facts for every discovered tool under `tools/`.
 * Discovery reuses `discoverToolIds` (manifest-gated, sorted, excludes hidden +
 * template). Folder names that do not match `SAFE_TOOL_ID` are dropped as a
 * trust-boundary guard so only safe ids ever reach the shell command slot.
 */
export function gatherToolSetupFacts(workspaceRoot: string): ToolSetupFacts[] {
  return discoverToolIds(workspaceRoot)
    .filter((id) => SAFE_TOOL_ID.test(id))
    .map((id) => {
      const dir = path.join(workspaceRoot, 'tools', id);
      return {
        id,
        hasPackageJson: fs.existsSync(path.join(dir, 'package.json')),
        isUvTool: fs.existsSync(path.join(dir, 'pyproject.toml')),
        hasSetupTask: taskfileHasSetupTask(path.join(dir, 'Taskfile.yml')),
      };
    });
}

/** Render a plan as the line-oriented protocol the root `setup` shell loop reads. */
function renderPlanLines(plan: SetupPlan): string[] {
  const lines: string[] = [];
  for (const step of plan.steps) {
    if (step.installPnpm) lines.push(`PNPM ${step.id}`);
  }
  if (plan.runUvSync) lines.push('UVSYNC');
  for (const step of plan.steps) {
    if (step.runSetup) lines.push(`SETUP ${step.id}`);
  }
  return lines;
}

async function cmdPlan(workspaceRoot: string): Promise<void> {
  const registry = createManifestRegistry(workspaceRoot);
  await registry.refresh();
  const enabledIds = new Set<string>(registry.enabled().map((m) => m.id));
  const facts = gatherToolSetupFacts(workspaceRoot);
  for (const f of facts) {
    if (!enabledIds.has(f.id)) process.stderr.write(`  [skip] tools/${f.id} is disabled\n`);
  }
  const plan = planToolSetup(facts, enabledIds);
  for (const line of renderPlanLines(plan)) process.stdout.write(`${line}\n`);
}

function cmdReport(failingIds: readonly string[]): void {
  const report = aggregateSetupFailures(failingIds.map((id) => ({ id, exitCode: 1 })));
  if (report.message) process.stdout.write(`${report.message}\n`);
  // Always exit 0: reporting a tool-setup failure must not fail the Core install.
}

function main(): void {
  const [, , mode, ...rest] = process.argv;
  if (mode === 'plan') {
    cmdPlan(rest[0] ?? process.cwd()).catch((err: unknown) => {
      process.stderr.write(`${String(err)}\n`);
      process.exitCode = 1;
    });
  } else if (mode === 'report') {
    cmdReport(rest);
  } else {
    process.stderr.write('usage: setup-planner.ts <plan [workspaceRoot] | report [id ...]>\n');
    process.exit(2);
  }
}

// Run the CLI only when executed directly (tsx setup-planner.ts <mode> ...).
// When imported by a test or by install-core the exported pure helpers are used
// directly, so this guard keeps main() (and its process.exit) from firing.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
