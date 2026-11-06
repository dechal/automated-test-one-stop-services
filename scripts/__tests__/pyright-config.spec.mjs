// @ts-check
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildConfig } from '../pyright-config.mjs';

/**
 * @param {string} root
 * @param {string} id
 * @param {Record<string, unknown>} manifest
 * @param {string[]} dirs
 */
function makeTool(root, id, manifest, dirs) {
  const dir = path.join(root, 'tools', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'tool.manifest.json'), JSON.stringify(manifest));
  for (const sub of dirs) mkdirSync(path.join(dir, sub), { recursive: true });
}

test('one environment per enabled Python tool, with OS-specific site-packages', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pyright-config-'));
  try {
    makeTool(root, 'py-a', { runtime: 'python' }, ['resources', '.venv/Lib/site-packages']);
    makeTool(root, 'py-b', { runtime: 'python' }, ['.venv/lib/python3.14/site-packages']);
    makeTool(root, 'py-off', { runtime: 'python', enabled: false }, ['resources']);
    makeTool(root, 'node-x', { runtime: 'node' }, ['resources']);

    const win = buildConfig(root, 'win32').executionEnvironments;
    assert.deepEqual(win, [
      {
        root: 'tools/py-a',
        extraPaths: ['tools/py-a/resources', 'tools/py-a/.venv/Lib/site-packages'],
      },
      { root: 'tools/py-b', extraPaths: [] },
      { root: '.' },
    ]);

    const linux = buildConfig(root, 'linux').executionEnvironments;
    assert.deepEqual(linux[1], {
      root: 'tools/py-b',
      extraPaths: ['tools/py-b/.venv/lib/python3.14/site-packages'],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
