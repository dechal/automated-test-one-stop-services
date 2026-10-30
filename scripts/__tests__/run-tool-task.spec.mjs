import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { presentToolIds, runToolTask, toolsWithTask } from '../lib/run-tool-task.mjs';

/** @param {string} root @param {string} id @param {string | undefined} taskfile */
const tool = (root, id, taskfile) => {
  const dir = path.join(root, 'tools', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'tool.manifest.json'), '{}');
  if (taskfile !== undefined) writeFileSync(path.join(dir, 'Taskfile.yml'), taskfile);
};

describe('run-tool-task', () => {
  /** @type {string} */
  let root;

  before(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'run-tool-task-'));
    tool(root, 'alpha', 'version: "3"\r\ntasks:\r\n  check:\r\n    cmds: [echo a]\r\n');
    tool(
      root,
      'beta',
      'version: "3"\ntasks:\n  setup:\n    cmds: [echo b]\n  precheck:\n    cmds: [echo c]\n',
    );
    tool(root, 'gamma', 'version: "3"\ntasks:\n  check:\n    cmds: [echo g]\n');
    tool(root, 'my-tool-template-example', 'version: "3"\ntasks:\n  check:\n    cmds: [echo t]\n');
    tool(root, 'no-taskfile', undefined);
    mkdirSync(path.join(root, 'tools', 'no-manifest'), { recursive: true });
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('discovers present tools by manifest and skips templates', () => {
    assert.deepEqual(presentToolIds(root), ['alpha', 'beta', 'gamma', 'no-taskfile']);
  });

  it('selects only tools whose Taskfile defines the task as a top-level entry', () => {
    assert.deepEqual(toolsWithTask(root, 'check'), ['alpha', 'gamma']);
    assert.deepEqual(toolsWithTask(root, 'setup'), ['beta']);
  });

  it('runs every matching tool and returns the ones that failed', () => {
    /** @type {string[]} */
    const ran = [];
    const failed = runToolTask({
      root,
      task: 'check',
      run: (_root, id) => {
        ran.push(id);
        return id !== 'alpha';
      },
      log: () => {},
    });
    assert.deepEqual(ran, ['alpha', 'gamma']);
    assert.deepEqual(failed, ['alpha']);
  });

  it('is a no-op when tools/ is missing', () => {
    assert.deepEqual(presentToolIds(path.join(root, 'absent')), []);
  });
});
