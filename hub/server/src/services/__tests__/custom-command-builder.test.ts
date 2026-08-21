import path from 'node:path';
import type { CustomCommand } from '@hub/shared';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_ROOT } from '../../config.js';
import { buildCustomCommand, validateCustomCommand } from '../custom-command-builder.js';

/**
 * Custom schedules run a free-text command, which is the ONE place in the Hub that
 * does not come from a tool manifest. The fence that keeps it honest is the
 * workspace-relative `cwd` check, enforced at create time.
 */
describe('validateCustomCommand', () => {
  const cmd = (over: Partial<CustomCommand> = {}): CustomCommand => ({
    script: 'task lint',
    ...over,
  });

  it('accepts a plain command with no cwd', () => {
    expect(validateCustomCommand(cmd())).toBeNull();
  });

  it('accepts a cwd inside the workspace', () => {
    expect(validateCustomCommand(cmd({ cwd: 'tools/k6' }))).toBeNull();
    expect(validateCustomCommand(cmd({ cwd: './scripts' }))).toBeNull();
  });

  it('rejects an empty or whitespace-only script', () => {
    expect(validateCustomCommand(cmd({ script: '' }))?.code).toBe('EMPTY_SCRIPT');
    expect(validateCustomCommand(cmd({ script: '   ' }))?.code).toBe('EMPTY_SCRIPT');
  });

  it('rejects traversal out of the workspace', () => {
    expect(validateCustomCommand(cmd({ cwd: '../..' }))?.code).toBe('CWD_OUTSIDE_WORKSPACE');
    expect(validateCustomCommand(cmd({ cwd: 'tools/../../elsewhere' }))?.code).toBe(
      'CWD_OUTSIDE_WORKSPACE',
    );
  });

  it('rejects an absolute path outside the workspace', () => {
    const outside = path.resolve(WORKSPACE_ROOT, '..', 'other-repo');
    expect(validateCustomCommand(cmd({ cwd: outside }))?.code).toBe('CWD_OUTSIDE_WORKSPACE');
  });

  it('treats a blank cwd as "no cwd" rather than a rejection', () => {
    expect(validateCustomCommand(cmd({ cwd: '   ' }))).toBeNull();
  });
});

describe('buildCustomCommand', () => {
  it('returns the script unchanged when there is nothing to add', () => {
    expect(buildCustomCommand({ script: 'task lint' })).toBe('task lint');
  });

  it('appends args', () => {
    expect(buildCustomCommand({ script: 'node seed.mjs', args: '--rows 100' })).toBe(
      'node seed.mjs --rows 100',
    );
  });

  it('prefixes a cd for a cwd, quoted so spaces survive', () => {
    expect(buildCustomCommand({ script: 'npm run x', cwd: 'my dir' })).toBe(
      "cd 'my dir' && npm run x",
    );
  });

  it('escapes a single quote in the cwd so the prefix cannot be broken out of', () => {
    expect(buildCustomCommand({ script: 'ls', cwd: "it's" })).toBe("cd 'it'\\''s' && ls");
  });

  it('trims stray whitespace instead of emitting a double space', () => {
    expect(buildCustomCommand({ script: '  task lint  ', args: '  -v  ' })).toBe('task lint -v');
  });
});
