// @ts-check
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE_SUFFIX = '-template-example';
const TOOL_SKIP = new Set([
  'projects',
  'node_modules',
  '.venv',
  '.git',
  'outputs',
  'docker-compose.yml',
]);
const STEP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 900_000;
const IS_WINDOWS = process.platform === 'win32';

/** @typedef {{ label: string, cmd: string, args: string[] }} Step */

function resolveTsxCli() {
  try {
    return createRequire(path.join(ROOT, 'package.json')).resolve('tsx/cli');
  } catch {
    return null;
  }
}

function resolveTy() {
  const bin = path.join(
    ROOT,
    '.venv',
    IS_WINDOWS ? 'Scripts' : 'bin',
    IS_WINDOWS ? 'ty.exe' : 'ty',
  );
  return fs.existsSync(bin) ? bin : null;
}

/**
 * @param {string} src
 * @param {string} dest
 */
function copyToolSkeleton(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (TOOL_SKIP.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyToolSkeleton(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

/** @returns {string[]} */
function presentToolIds() {
  const toolsDir = path.join(ROOT, 'tools');
  if (!fs.existsSync(toolsDir)) return [];
  return fs
    .readdirSync(toolsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.endsWith(TEMPLATE_SUFFIX))
    .filter((e) => fs.existsSync(path.join(toolsDir, e.name, 'tool.manifest.json')))
    .map((e) => e.name)
    .sort();
}

/** @returns {string} */
function buildSkeleton() {
  const scratch = path.join(ROOT, '.cache', 'deletable');
  fs.mkdirSync(scratch, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(scratch, 'removability-'));
  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((f) => f !== '' && (!f.startsWith('hub/') || /^hub\/[^/]+$/.test(f)));
  for (const rel of tracked) {
    const from = path.join(ROOT, rel);
    if (!fs.existsSync(from) || !fs.statSync(from).isFile()) continue;
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.copyFileSync(from, path.join(tmp, rel));
  }
  for (const id of presentToolIds())
    copyToolSkeleton(path.join(ROOT, 'tools', id), path.join(tmp, 'tools', id));
  return tmp;
}

/**
 * @param {string} cwd
 * @param {Step} step
 * @returns {string | null}
 */
function runStep(cwd, step) {
  const res = spawnSync(step.cmd, step.args, {
    cwd,
    encoding: 'utf8',
    timeout: STEP_TIMEOUT_MS,
    env: { ...process.env, CI: 'true', NO_COLOR: '1' },
  });
  if (res.status === 0) return null;
  const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
    .trim()
    .split(/\r?\n/)
    .slice(-8)
    .join('\n    ');
  return `${step.label} exited ${res.status ?? res.signal ?? res.error?.message}\n    ${out}`;
}

/**
 * @param {string} tmp
 * @param {string} tsx
 * @param {string | null} ty
 * @returns {Step[]}
 */
function steps(tmp, tsx, ty) {
  /** @type {Step[]} */
  const list = [
    {
      label: 'generator (sync-projects)',
      cmd: process.execPath,
      args: [tsx, 'scripts/sync-projects.ts'],
    },
    {
      label: 'planner (setup-planner plan)',
      cmd: process.execPath,
      args: [tsx, 'scripts/manifests/setup-planner.ts', 'plan', tmp],
    },
    { label: 'task --list', cmd: 'task', args: ['--list'] },
  ];
  if (ty !== null) {
    list.push({
      label: 'ty check (root config)',
      cmd: ty,
      args: ['check', '--project', tmp, '--python', path.join(ROOT, '.venv')],
    });
  }
  return list;
}

test('removing any tool or hub/ leaves the generator, planner, task list and ty green (guard G-01)', {
  timeout: TEST_TIMEOUT_MS,
}, (t) => {
  const tsx = resolveTsxCli();
  assert.ok(
    tsx !== null,
    'tsx is not resolvable from the root package.json (it must be a root devDependency)',
  );
  const taskProbe = spawnSync('task', ['--version'], { encoding: 'utf8' });
  assert.equal(taskProbe.status, 0, '`task` (go-task) is not on PATH');
  const ty = resolveTy();
  if (ty === null)
    t.diagnostic('ty is not installed in the root .venv; the ty step is not exercised');

  const tmp = buildSkeleton();
  const parked = fs.mkdtempSync(path.join(path.dirname(tmp), 'removability-parked-'));
  const blocks = [null, ...presentToolIds().map((id) => `tools/${id}`), 'hub'];
  const failures = [];
  try {
    for (const block of blocks) {
      const parkedAt = block === null ? null : path.join(parked, block.replace('/', '__'));
      if (block !== null && parkedAt !== null) fs.renameSync(path.join(tmp, block), parkedAt);
      for (const step of steps(tmp, tsx, ty)) {
        const failure = runStep(tmp, step);
        if (failure !== null) failures.push(`without ${block ?? 'nothing'}: ${failure}`);
      }
      if (block !== null && parkedAt !== null) fs.renameSync(parkedAt, path.join(tmp, block));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(parked, { recursive: true, force: true });
  }
  assert.deepEqual(failures, [], `a block cannot be removed cleanly:\n${failures.join('\n')}`);
});
