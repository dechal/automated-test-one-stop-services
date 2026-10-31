// scripts/manifests/__tests__/setup-state.properties.spec.ts
//
// Property-based test for the Setup_State ledger engine
// (scripts/setup/setup-state.mjs) — the canonical read / write / resume logic
// both bootstrap scripts shell out to. One property; ≥100 iterations;
// fast-check under vitest, mirroring the scripts/manifests/__tests__/ convention
// (plain vitest + fc.assert, tmp-dir round-trip like the discovery property).
//

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import {
  migrateLegacyState,
  readState,
  STEP_ORDER,
  selectResumeStep,
  writeState,
} from '../../setup/setup-state.mjs';
import { makeTmpDir, rmTmpDir } from './_helpers.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmTmpDir(d);
});

/** A random State_Ledger `steps` map: every canonical step → a valid status. */
const arbLedgerSteps = fc.record(
  Object.fromEntries(STEP_ORDER.map((s) => [s, fc.constantFrom('pending', 'done', 'failed')])),
);

// =============================================================================
// Ledger round-trip and resume selection.
// For any State_Ledger value, writing then reading the ledger yields an
// equivalent value (round-trip), and the resume selector returns the first step
// in STEP_ORDER whose recorded status is not `done`, skipping all `done` steps.
// =============================================================================
describe('Ledger round-trip and resume selection', () => {
  it('round-trips the ledger and resumes at the first non-done step', () => {
    const dir = makeTmpDir('setup-state-');
    tmpDirs.push(dir);
    const stateFile = path.join(dir, 'setup-state.json');

    fc.assert(
      fc.property(arbLedgerSteps, (steps) => {
        // Round-trip: write then read yields an equivalent steps map.
        writeState(stateFile, steps);
        expect(readState(stateFile).steps).toEqual(steps);

        // Resume = the first STEP_ORDER step that is not "done" (null if all done) …
        const resume = selectResumeStep(steps);
        const firstNotDone = STEP_ORDER.find((s) => steps[s] !== 'done') ?? null;
        expect(resume).toBe(firstNotDone);

        // … and every step before the resume point is "done" (done steps skipped).
        const idx = resume === null ? STEP_ORDER.length : STEP_ORDER.indexOf(resume);
        for (let i = 0; i < idx; i++) expect(steps[STEP_ORDER[i]]).toBe('done');
      }),
      { numRuns: 200 },
    );
  });
});
describe('Legacy ledger migration', () => {
  it('moves a legacy ledger onto an absent state file and keeps its steps', () => {
    const dir = makeTmpDir('setup-state-legacy-');
    tmpDirs.push(dir);
    const legacy = path.join(dir, '.setup-state.json');
    const stateFile = path.join(dir, '.cache', 'state', 'setup-state.json');
    const steps = Object.fromEntries(STEP_ORDER.map((s) => [s, 'done']));
    writeState(legacy, steps);
    expect(migrateLegacyState(stateFile, legacy)).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(readState(stateFile).steps).toEqual(steps);
    writeState(legacy, {});
    expect(migrateLegacyState(stateFile, legacy)).toBe(false);
    expect(readState(stateFile).steps).toEqual(steps);
  });
});
