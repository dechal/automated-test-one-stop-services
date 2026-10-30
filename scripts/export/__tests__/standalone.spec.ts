import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  exportProjectStandalone,
  getStandaloneStrategy,
  isStandaloneSupported,
  STANDALONE_STAGES,
} from '../standalone.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-standalone-'));
  fs.mkdirSync(path.join(root, 'tools', 'k6', 'projects', 'performance', 'demo', 'automations'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(root, 'tools', 'k6', 'resources'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const base = (targetDir: string) => ({
  workspaceRoot: root,
  tool: 'k6',
  type: 'performance',
  project: 'demo',
  targetDir,
});

describe('isStandaloneSupported', () => {
  it.each(['playwright', 'k6', 'robot-framework', 'pywinauto'])('supports %s', (tool) => {
    expect(isStandaloneSupported(tool)).toBe(true);
  });

  it('rejects unknown tools and prototype keys', () => {
    expect(isStandaloneSupported('mobilewright')).toBe(false);
    expect(getStandaloneStrategy('constructor')).toBeUndefined();
  });

  it('keeps the stage list unchanged', () => {
    expect(STANDALONE_STAGES).toEqual([
      'validate',
      'copy-project',
      'copy-resources',
      'rewrite',
      'generate',
      'embed-key',
      'install',
    ]);
  });
});

describe('exportProjectStandalone validation', () => {
  it('returns TOOL_NOT_SUPPORTED for an unknown tool', async () => {
    const res = await exportProjectStandalone({ ...base(path.join(root, 'out')), tool: 'nope' });
    expect(res).toMatchObject({ code: 'TOOL_NOT_SUPPORTED' });
  });

  it('returns SOURCE_MISSING when the project folder is absent', async () => {
    const res = await exportProjectStandalone({ ...base(path.join(root, 'out')), project: 'x' });
    expect(res).toMatchObject({ code: 'SOURCE_MISSING' });
  });

  it('refuses a non-empty folder without an embed key', async () => {
    const target = path.join(root, 'out');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'foreign.txt'), 'x');
    const res = await exportProjectStandalone(base(target));
    expect(res).toMatchObject({ code: 'TARGET_NOT_EMPTY' });
  });

  it('refuses a standalone export made for another tool', async () => {
    const target = path.join(root, 'out');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, '.standalone.json'), JSON.stringify({ tool: 'playwright' }));
    const res = await exportProjectStandalone(base(target));
    expect(res).toMatchObject({ code: 'TARGET_TOOL_MISMATCH' });
  });
});
