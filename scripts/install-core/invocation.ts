// scripts/install-core/invocation.ts
//
// Fixed-constant child-process invocation builders for the shared install
// pipeline.
//
// Every invocation is argv-form (a fixed executable + a fixed argv array), never
// a shell string. That is the whole point of no tool-supplied value
// is ever interpolated into a shell. The only variable parts of a built argv are
// `tools/<id>` path slots, and `<id>` is SAFE_ID-validated before it gets here.
//
// Mirrors the `installToolDependencies` pattern in
// `hub/server/src/services/tool-plugins.ts` (fixed command constants, a wall-clock
// timeout, captured `stdio: 'pipe'`, and `windowsHide`) — but upgrades the
// shelled `execSync(string)` to argv-form so there is no shell to inject into.

import { SAFE_GIT_REF, SAFE_GIT_URL, SAFE_ID } from './validation.js';

/**
 * Safe spawn options shared by every install-core child process. `cwd` is
 * deliberately omitted: the effects layer supplies it, so the invocation itself
 * stays environment-independent and assertion-friendly.
 */
export interface SpawnOptions {
  readonly timeout: number;
  readonly stdio: 'pipe';
  readonly windowsHide: true;
}

/**
 * A fully-built, shell-free child-process invocation: a fixed executable, a
 * fixed argv (with only SAFE_ID-validated path slots), and the safe spawn options.
 */
export interface ChildInvocation {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

/** Package managers install-core knows how to provision deps for. */
export type ToolPackageManager = 'pnpm' | 'uv';

/**
 * A dependency-install invocation plus where it runs: a pnpm tool installs in
 * its own folder (`--ignore-workspace`), a uv tool syncs from the workspace root.
 * The effects layer resolves `cwd` to an absolute path (the tool id never enters
 * the argv — for pnpm it lives only in the resolved `cwd`).
 */
export interface DepsInvocation extends ChildInvocation {
  readonly cwd: 'toolDir' | 'workspaceRoot';
}

/** Input for a registry clone invocation. */
export interface CloneInput {
  readonly id: string;
  readonly gitUrl: string;
  readonly ref: string;
}

/** Max wall-clock time for a tool's `setup` task (mirrors DEPS_INSTALL_TIMEOUT_MS). */
export const TOOL_SETUP_TIMEOUT_MS = 180_000;
/** Max wall-clock time for a dependency install (mirrors the Hub's value). */
export const DEPS_INSTALL_TIMEOUT_MS = 180_000;
/** Max wall-clock time for a git clone (mirrors the Hub's clone timeout). */
export const GIT_CLONE_TIMEOUT_MS = 60_000;

/** The kind of input that failed a builder's defence-in-depth guard. */
export type UnsafeInputKind = 'id' | 'gitUrl' | 'gitRef';

/**
 * Thrown when an invocation builder is handed a value that fails its safe
 * pattern. A programming-error guard: the pipeline validates first (returning a
 * structured result), so this never fires on the normal path — it exists so an
 * unsafe value can never be turned into an argv even if a caller forgets to
 * validate.
 */
export class UnsafeInvocationInput extends Error {
  readonly kind: UnsafeInputKind;
  readonly value: string;

  constructor(kind: UnsafeInputKind, value: string) {
    super(`unsafe ${kind} reached an invocation builder: ${JSON.stringify(value)}`);
    this.name = 'UnsafeInvocationInput';
    this.kind = kind;
    this.value = value;
  }
}

function makeOptions(timeout: number): SpawnOptions {
  return { timeout, stdio: 'pipe', windowsHide: true };
}

function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) throw new UnsafeInvocationInput('id', id);
}

/**
 * Build the fixed-constant Tool_Setup_Task invocation:
 *
 * task --taskfile tools/<id>/Taskfile.yml --dir tools/<id> setup
 *
 * The executable (`task`), the flags (`--taskfile`, `--dir`), and the subcommand
 * (`setup`) are constants. The ONLY variable parts are the two `tools/<id>/…`
 * path slots, and `<id>` is SAFE_ID-validated. Run from the workspace root (the
 * effects layer sets `cwd`).
 */
export function buildToolSetupInvocation(id: string): ChildInvocation {
  assertSafeId(id);
  return {
    file: 'task',
    args: ['--taskfile', `tools/${id}/Taskfile.yml`, '--dir', `tools/${id}`, 'setup'],
    options: makeOptions(TOOL_SETUP_TIMEOUT_MS),
  };
}

/**
 * Build the fixed-constant dependency-install invocation, mirroring
 * `installToolDependencies`: pnpm → `pnpm install --ignore-workspace` inside
 * `tools/<id>`; uv → `uv sync` at the workspace root. No id is interpolated into
 * argv — for pnpm the id lives only in the `cwd` path the effects layer builds.
 */
export function buildDepsInstallInvocation(manager: ToolPackageManager): DepsInvocation {
  if (manager === 'pnpm') {
    return {
      file: 'pnpm',
      args: ['install', '--ignore-workspace'],
      options: makeOptions(DEPS_INSTALL_TIMEOUT_MS),
      cwd: 'toolDir',
    };
  }
  return {
    file: 'uv',
    args: ['sync'],
    options: makeOptions(DEPS_INSTALL_TIMEOUT_MS),
    cwd: 'toolDir',
  };
}

/**
 * Build the fixed-constant registry clone invocation (argv-form, no shell):
 *
 * git clone <gitUrl> --branch <ref> --single-branch --depth 1 tools/<id>
 *
 * Validates id (SAFE_ID), url (SAFE_GIT_URL) and ref (SAFE_GIT_REF) as defence in
 * depth — the pipeline already gated id + url, but argv-form plus these guards
 * mean no value can break out of the command. Run from the workspace root (the
 * relative `tools/<id>` target resolves under it).
 */
export function buildGitCloneInvocation(input: CloneInput): ChildInvocation {
  assertSafeId(input.id);
  if (!SAFE_GIT_URL.test(input.gitUrl)) throw new UnsafeInvocationInput('gitUrl', input.gitUrl);
  if (!SAFE_GIT_REF.test(input.ref)) throw new UnsafeInvocationInput('gitRef', input.ref);
  return {
    file: 'git',
    args: [
      'clone',
      input.gitUrl,
      '--branch',
      input.ref,
      '--single-branch',
      '--depth',
      '1',
      `tools/${input.id}`,
    ],
    options: makeOptions(GIT_CLONE_TIMEOUT_MS),
  };
}
