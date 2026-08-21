import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  DOTENVX_WRAPPED_FAILURE,
  parseChildExitCode,
  resolveChildExitCode,
} from '../lib/child-exit-code.mjs';

/**
 * `dotenvx run` reports 126 for any failed child and hides the child's real code
 * in a stderr line. These pin the recovery so a k6 threshold breach (99) stops
 * being flattened into 126 downstream.
 */
describe('parseChildExitCode', () => {
  it('reads the code out of a real dotenvx failure line', () => {
    const line = '☠ Command failed with exit code 99: C:\\shims\\k6.EXE run ./spec.ts -e ROUND=1';
    assert.equal(parseChildExitCode(line), 99);
  });

  it('takes the LAST occurrence, so a looping runner reports the latest attempt', () => {
    const text = [
      'Command failed with exit code 99: first',
      'Command failed with exit code 1: second',
    ].join('\n');
    assert.equal(parseChildExitCode(text), 1);
  });

  it('returns null when the log holds no such line', () => {
    assert.equal(parseChildExitCode('running (11.5s), 0/5 VUs, 9 complete'), null);
  });
});

describe('resolveChildExitCode', () => {
  let dir;
  let logPath;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'child-exit-'));
    logPath = path.join(dir, 'report.log');
    fs.writeFileSync(logPath, 'Command failed with exit code 99: k6.EXE run\n', 'utf8');
  });

  after(() => {
    fs.rmSync(dir, { force: true, recursive: true });
  });

  it('recovers the child code when the shell saw dotenvx 126', () => {
    assert.equal(resolveChildExitCode(logPath, DOTENVX_WRAPPED_FAILURE), 99);
  });

  it('passes a success through untouched', () => {
    assert.equal(resolveChildExitCode(logPath, 0), 0);
  });

  it('never rewrites a code that is not dotenvx 126', () => {
    assert.equal(resolveChildExitCode(logPath, 1), 1);
    assert.equal(resolveChildExitCode(logPath, 99), 99);
  });

  it('keeps 126 when the log is missing, so a failure stays a failure', () => {
    assert.equal(
      resolveChildExitCode(path.join(dir, 'no-such.log'), DOTENVX_WRAPPED_FAILURE),
      DOTENVX_WRAPPED_FAILURE,
    );
  });

  it('keeps 126 when the log has no parseable line', () => {
    const plain = path.join(dir, 'plain.log');
    fs.writeFileSync(plain, 'no marker here\n', 'utf8');
    assert.equal(resolveChildExitCode(plain, DOTENVX_WRAPPED_FAILURE), DOTENVX_WRAPPED_FAILURE);
  });
});
