#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listGitDirs } from './list-git-dirs.mjs';

/**
 * @typedef {object} PullTarget
 * @property {string} name label printed for the repo
 * @property {string} dir absolute repo directory
 */

/** @returns {string} */
export function workspaceRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * @param {string} root workspace root
 * @param {string} [subdir] folder searched for nested repos
 * @returns {PullTarget[]}
 */
export function planPulls(root, subdir = 'tools') {
  const base = path.join(root, subdir);
  const nested = listGitDirs(base.split(path.sep).join('/')).map((gitDir) => {
    const dir = path.dirname(gitDir);
    return { name: path.relative(base, dir).split(path.sep).join('/'), dir: path.resolve(dir) };
  });
  return [{ name: 'root', dir: root }, ...nested];
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function gitPull(dir) {
  return spawnSync('git', ['pull', '--ff-only'], { cwd: dir, stdio: 'inherit' }).status === 0;
}

/**
 * @param {PullTarget[]} targets
 * @param {(dir: string) => boolean} [pull]
 * @param {(line: string) => void} [log]
 * @returns {string[]} names of the repos that failed
 */
export function pullAll(targets, pull = gitPull, log = console.log) {
  /** @type {string[]} */
  const failed = [];
  for (const { name, dir } of targets) {
    log(`  [${name}] pulling...`);
    if (pull(dir)) log(`  [${name}] done`);
    else {
      log(`  [${name}] failed`);
      failed.push(name);
    }
    log('');
  }
  return failed;
}

function main() {
  console.log('');
  console.log('Pulling all git subprojects...');
  console.log('');
  const failed = pullAll(planPulls(workspaceRoot()));
  console.log(
    failed.length === 0
      ? 'All repos pulled successfully.'
      : `${failed.length} repo(s) failed to pull.`,
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
