#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MANIFEST_FILENAME = 'tool.manifest.json';
export const TEMPLATE_EXAMPLE_SUFFIX = '-template-example';
const SAFE_ID = /^[a-z][a-z0-9-]*$/;
const SAFE_TASK = /^[a-z][a-z0-9:_-]*$/;

/** @returns {string} */
export function workspaceRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * @param {string} root
 * @returns {string[]} ids of every present tool, sorted, without templates
 */
export function presentToolIds(root) {
  const toolsDir = path.join(root, 'tools');
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = readdirSync(toolsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (d) =>
        d.isDirectory() &&
        !d.name.startsWith('.') &&
        !d.name.endsWith(TEMPLATE_EXAMPLE_SUFFIX) &&
        SAFE_ID.test(d.name) &&
        existsSync(path.join(toolsDir, d.name, MANIFEST_FILENAME)),
    )
    .map((d) => d.name)
    .sort();
}

/**
 * @param {string} taskfilePath
 * @param {string} task
 * @returns {boolean}
 */
export function taskfileHasTask(taskfilePath, task) {
  try {
    const text = readFileSync(taskfilePath, 'utf8').replace(/\r\n/g, '\n');
    return new RegExp(`\\n {2}${task.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`).test(text);
  } catch {
    return false;
  }
}

/**
 * @param {string} root
 * @param {string} task
 * @returns {string[]} ids of present tools whose Taskfile defines `task`
 */
export function toolsWithTask(root, task) {
  return presentToolIds(root).filter((id) =>
    taskfileHasTask(path.join(root, 'tools', id, 'Taskfile.yml'), task),
  );
}

/**
 * @param {string} root
 * @param {string} id
 * @param {string} task
 * @returns {boolean}
 */
function runTask(root, id, task) {
  const dir = path.join('tools', id);
  const result = spawnSync(
    'task',
    ['--taskfile', path.join(dir, 'Taskfile.yml'), '--dir', dir, task],
    { cwd: root, stdio: 'inherit' },
  );
  return result.status === 0;
}

/**
 * @param {{ root: string; task: string; run?: (root: string, id: string, task: string) => boolean; log?: (line: string) => void }} options
 * @returns {string[]} ids whose task failed
 */
export function runToolTask({ root, task, run = runTask, log = console.log }) {
  /** @type {string[]} */
  const failed = [];
  for (const id of toolsWithTask(root, task)) {
    log(`[${task}] tools/${id}`);
    if (!run(root, id, task)) failed.push(id);
  }
  return failed;
}

function main() {
  const task = process.argv[2];
  if (!task || !SAFE_TASK.test(task)) {
    console.error('usage: run-tool-task.mjs <task>');
    process.exit(2);
  }
  const failed = runToolTask({ root: workspaceRoot(), task });
  if (failed.length > 0) {
    console.error(`[${task}] failed: ${failed.map((id) => `tools/${id}`).join(', ')}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
