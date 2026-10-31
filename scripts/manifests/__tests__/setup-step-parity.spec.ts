// scripts/manifests/__tests__/setup-step-parity.spec.ts
//
// Example tests for setup-step parity across the two platform scripts:
//  - Core_Tool_Set + STEP_ORDER parity across BOTH bootstrap scripts: identical
//    step names and ordering, the same total, and only Core members treated as
//    mandatory in the post-setup verify.
//  - A forced Core step failure marks the ledger `failed`, never resumes at
//    start-hub, and both scripts stop with a remediation hint and no silent
//    privilege escalation.
//

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readState, STEP_ORDER, selectResumeStep, writeState } from '../../setup/setup-state.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const SETUP_DIR = path.join(REPO_ROOT, 'scripts', 'setup');
const WIN = fs.readFileSync(path.join(SETUP_DIR, 'setup-windows.bat'), 'utf8');
const NIX = fs.readFileSync(path.join(SETUP_DIR, 'setup-linux.sh'), 'utf8');

const CORE_TOOL_SET = ['node', 'pnpm', 'uv', 'task'];
const EXPECTED_STEP_ORDER = [...CORE_TOOL_SET, 'install-deps', 'start-hub'];

/** Ordered `[step] <name> (n/total)` step names a script declares. */
function stepLabels(script: string): string[] {
  return [...script.matchAll(/\[step\]\s+([a-z0-9-]+)\s+\(\d+\/\d+\)/g)].map((m) => m[1]);
}
/** The `total` denominators in each `(n/total)` step label. */
function stepTotals(script: string): number[] {
  return [...script.matchAll(/\[step\]\s+[a-z0-9-]+\s+\(\d+\/(\d+)\)/g)].map((m) => Number(m[1]));
}
/** Ordered tools each script verifies post-setup (`verify <t> "` / `call :verify <t> "`). */
function verifyTargets(script: string): string[] {
  return [...script.matchAll(/(?:call :)?verify\s+([a-z0-9-]+)\s+"/g)].map((m) => m[1]);
}

describe('Core_Tool_Set + STEP_ORDER parity', () => {
  it('the ledger engine STEP_ORDER is Core + install-deps + start-hub, with k6 removed', () => {
    expect(STEP_ORDER).toEqual(EXPECTED_STEP_ORDER);
    expect(STEP_ORDER).not.toContain('k6');
  });

  it('both scripts declare the same step names in the same order', () => {
    expect(stepLabels(NIX)).toEqual(EXPECTED_STEP_ORDER);
    expect(stepLabels(WIN)).toEqual(EXPECTED_STEP_ORDER);
    expect(stepLabels(WIN)).toEqual(stepLabels(NIX));
  });

  it('both scripts number every step out of the same total', () => {
    const total = EXPECTED_STEP_ORDER.length;
    expect(new Set(stepTotals(NIX))).toEqual(new Set([total]));
    expect(new Set(stepTotals(WIN))).toEqual(new Set([total]));
  });

  it('only Core_Tool_Set members are mandatory in the verify — k6 is not', () => {
    expect(verifyTargets(NIX)).toEqual(CORE_TOOL_SET);
    expect(verifyTargets(WIN)).toEqual(CORE_TOOL_SET);
    expect(NIX).not.toMatch(/verify\s+k6/);
    expect(WIN).not.toMatch(/verify\s+k6/);
  });

  it('k6 is not a mandatory installer step on either platform', () => {
    expect(stepLabels(NIX)).not.toContain('k6');
    expect(stepLabels(WIN)).not.toContain('k6');
  });
});

describe('Core step failure: ledger failed, no start-hub, hint printed', () => {
  it('a failed Core step persists as "failed" and never resumes at start-hub', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-fail-'));
    try {
      const stateFile = path.join(dir, 'setup-state.json');
      // node done, pnpm failed → a re-run resumes at the failed step, not later.
      const steps = {
        node: 'done',
        pnpm: 'failed',
        uv: 'pending',
        task: 'pending',
        'install-deps': 'pending',
        'start-hub': 'pending',
      };
      writeState(stateFile, steps);

      const back = readState(stateFile).steps;
      expect(back.pnpm).toBe('failed');

      const resume = selectResumeStep(back);
      expect(resume).toBe('pnpm');
      expect(resume).not.toBe('start-hub');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('both scripts stop with a remediation hint and start-hub is last', () => {
    // Linux: fail_step records the failure, prints a [hint], and exits.
    expect(NIX).toMatch(/fail_step\(\)\s*\{/);
    expect(NIX).toMatch(/\[hint\]/);
    expect(NIX).toMatch(/exit 1/);
    expect(NIX).toMatch(/fail_step node "node 1\/6"/);

    // Windows: :fail records the failure, prints a [hint], and the step exits.
    expect(WIN).toMatch(/:fail\b/);
    expect(WIN).toMatch(/\[hint\]/);
    expect(WIN).toMatch(/call :fail ST_node "node 1\/6"/);

    // start-hub is the LAST step on both (verify can only run after every step).
    expect(stepLabels(NIX).at(-1)).toBe('start-hub');
    expect(stepLabels(WIN).at(-1)).toBe('start-hub');
  });

  it('no Core step escalates privilege silently', () => {
    // After k6 removal no Core step needs root; neither script auto-escalates.
    expect(NIX).not.toMatch(/^\s*sudo\s+/m);
    expect(WIN).not.toMatch(/runas|-Verb\s+RunAs/i);
  });
});
