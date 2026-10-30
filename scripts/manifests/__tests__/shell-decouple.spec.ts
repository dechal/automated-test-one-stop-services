// scripts/manifests/__tests__/shell-decouple.spec.ts
//
// Test for the Windows shell/coreutils decoupling step (cross-shell `task` by
// default).
//
// Once the Taskfiles stopped calling the GNU-only `find` (the empty-dir prune,
// the artifact/node_modules sweeps, and `pull`'s `.git` discovery were ported to
// Node helpers under scripts/lib/, run via the always-present Core `node`), the
// ONLY externals that collide with a System32 twin (`find`/`sort`) are no longer
// needed by any recipe. Appending Git's usr\bin to the USER PATH therefore makes
// EVERY remaining (non-colliding) external resolvable in cmd/PowerShell — so the
// decoupling was flipped from opt-in to ON BY DEFAULT (opt OUT via
// SETUP_DISABLE_SHELL_DECOUPLE), while keeping its native-safety posture.
//
// Strategy was VERIFIED against the installed task 3.x / mvdan.cc/sh:
//   * `task` resolves a Taskfile external through mvdan/sh by walking PATH
//     front-to-back, exactly like native Windows — there is no Task-only lookup.
//   * Windows composes a process PATH as Machine-scope first, then User-scope,
//     and System32 lives in the Machine PATH. So APPENDING Git's usr\bin to the
//     USER PATH leaves native System32 find.exe/sort.exe ahead of it for bare
//     `find`/`sort` in cmd/PowerShell — they keep working — while the
//     non-colliding GNU tools become resolvable in every shell.
//
// Asserts:
//  (a) decoupling is ON by default and gated only by an opt-OUT flag, is
//      best-effort (warn-only, never exits non-zero), and is neither a Core
//      `[step]` nor a verify target — a Core install passes regardless;
//  (b) the PATH strategy keeps native Windows binaries working — APPENDS to the
//      USER PATH (never Machine, never an admin/RunAs prepend ahead of System32)
//      and documents that bare find/sort stay the native binaries.
//
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const WIN = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'setup', 'setup-windows.bat'), 'utf8');

const CORE_TOOL_SET = ['node', 'pnpm', 'uv', 'task'];
const EXPECTED_STEP_ORDER = [...CORE_TOOL_SET, 'install-deps', 'start-hub'];

/** Ordered `[step] <name> (n/total)` step names the script declares. */
function stepLabels(script: string): string[] {
  return [...script.matchAll(/\[step\]\s+([a-z0-9-]+)\s+\(\d+\/\d+\)/g)].map((m) => m[1]);
}
/** Ordered tools the script verifies post-setup (`verify <t> "` / `call :verify <t> "`). */
function verifyTargets(script: string): string[] {
  return [...script.matchAll(/(?:call :)?verify\s+([a-z0-9-]+)\s+"/g)].map((m) => m[1]);
}

describe('Shell decoupling of the user PATH is opt-in', () => {
  it('wires the step into setup and defines the routine', () => {
    expect(WIN).toMatch(/call :shellDecouple\b/);
    expect(WIN).toMatch(/^:shellDecouple\b/m);
  });

  it('changes the user PATH only when SETUP_ENABLE_SHELL_DECOUPLE=1', () => {
    // When SETUP_DISABLE_SHELL_DECOUPLE=1 the routine returns early; otherwise it
    // falls through, announces it is ON, and proceeds to resolve Git's usr\bin.
    expect(WIN).toMatch(/if \/I "%SETUP_ENABLE_SHELL_DECOUPLE%"=="1" set "_persistDecouple=1"/);
    const routine = WIN.slice(WIN.search(/\n:shellDecouple\r?\n/));
    const gate = routine.indexOf('if not defined _persistDecouple goto :eof');
    const persist = routine.search(/SetEnvironmentVariable\('PATH'/);
    expect(gate).toBeGreaterThan(0);
    expect(persist).toBeGreaterThan(gate);
  });

  it('adds Git usr\\bin to the setup session PATH only, so `task setup` still resolves it', () => {
    expect(WIN).toMatch(/set "PATH=%PATH%;%GIT_USRBIN%"/);
    expect(WIN).toMatch(/%%P%GIT_SESSION_PATH%"/);
  });

  it('no longer references the removed opt-out flag', () => {
    // The old opt-in gate (SETUP_ENABLE_SHELL_DECOUPLE) is gone entirely.
    expect(WIN).not.toMatch(/%SETUP_DISABLE_SHELL_DECOUPLE%/);
  });

  it('never force-sets the opt-in flag (stays off unless the caller opts in)', () => {
    // A real `set "SETUP_DISABLE_SHELL_DECOUPLE=1"` assignment would live at the
    // start of a line; comment/echo mentions (REM .../echo ...) must not count.
    expect(WIN).not.toMatch(/^\s*set\s+"?SETUP_ENABLE_SHELL_DECOUPLE\s*=\s*1/im);
  });

  it('is not a Core step and not a verify target — a Core install ignores it', () => {
    expect(stepLabels(WIN)).toEqual(EXPECTED_STEP_ORDER);
    expect(verifyTargets(WIN)).toEqual(CORE_TOOL_SET);
    // The decouple lines use the [opt] aux prefix, never [step].
    expect(WIN).toMatch(/\[opt\][^\n]*decoupl/i);
  });

  it('is best-effort: it only warns and never exits non-zero', () => {
    // Slice from the routine label to EOF (the routine + its sub-helpers) and
    // assert it never aborts the script. CRLF-safe locate.
    const idx = WIN.search(/\n:shellDecouple\r?\n/);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(WIN.slice(idx)).not.toMatch(/exit \/b 1/);
  });
});

describe('PATH strategy keeps native Windows binaries working', () => {
  it('persists onto the USER PATH scope, never the Machine PATH', () => {
    expect(WIN).toMatch(/SetEnvironmentVariable\('PATH',\s*[^,]+,\s*'User'\)/);
    expect(WIN).not.toMatch(/SetEnvironmentVariable\('PATH',\s*[^,]+,\s*'Machine'\)/);
  });

  it('does not elevate to force GNU ahead of System32 (no runas / RunAs)', () => {
    expect(WIN).not.toMatch(/runas|-Verb\s+RunAs/i);
  });

  it('APPENDS Git usr\\bin (existing PATH first), it does not prepend before System32', () => {
    // The new value is built as "<existing>;<gitUsrBin>", so the user entry lands
    // after System32 in the composed Machine+User PATH and native find/sort win.
    expect(WIN).toMatch(/\$p\.TrimEnd\(';'\)\s*\+\s*';'\s*\+\s*\$env:GIT_USRBIN/);
  });

  it('resolves Git usr\\bin robustly rather than hardcoding one path', () => {
    expect(WIN).toMatch(/where git/i);
    expect(WIN).toMatch(/ProgramFiles\(x86\)|LOCALAPPDATA/);
    // A candidate is accepted only when it actually contains find.exe.
    expect(WIN).toMatch(/find\.exe/i);
  });

  it('documents that bare find/sort stay the native Windows binaries', () => {
    expect(WIN).toMatch(/native[^\n]*find|find[^\n]*native/i);
  });
});
