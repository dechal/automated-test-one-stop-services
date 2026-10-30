#!/usr/bin/env node
import { existsSync, readdirSync, rmdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pruneEmptyDirs } from './prune-empty-dirs.mjs';

export const DEFAULT_RETENTION_DAYS = 30;
export const RETENTION_DAYS_ENV = 'OUTPUTS_RETENTION_DAYS';
export const KEEP_MARKERS = ['.lock', '.favorite'];

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_DIR = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_ENTRY = /^(\d{2})-(\d{2})-(\d{2})(?:\..+)?$/;
const SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * @typedef {object} RunEntry
 * @property {string} path absolute path of the run (time folder or loose time file)
 * @property {string} dateDir absolute path of its `YYYY-MM-DD` parent
 * @property {number} startedAt run start in epoch ms, read from the path (local time)
 * @property {boolean} kept true when the run carries a keep marker
 */

/**
 * @typedef {object} RetentionPlan
 * @property {RunEntry[]} expired runs older than the cutoff and not kept
 * @property {RunEntry[]} kept runs older than the cutoff that a marker protects
 * @property {string[]} emptyDateDirs expired `YYYY-MM-DD` folders that are already empty
 * @property {number} cutoff epoch ms; a run that started before it is expired
 */

/**
 * @typedef {object} RetentionResult
 * @property {RetentionPlan} plan
 * @property {string[]} removed
 * @property {string[]} failed
 * @property {string[]} prunedDirs
 */

/** @returns {string} */
export function defaultOutputsDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'outputs');
}

/**
 * @param {string | undefined} raw
 * @returns {number}
 */
export function parseRetentionDays(raw) {
  if (raw === undefined || raw.trim() === '') return DEFAULT_RETENTION_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`retention days must be a whole number >= 1, got "${raw}"`);
  }
  return days;
}

/**
 * @param {string} dateName
 * @param {string} timeName
 * @returns {number | undefined}
 */
export function runStartedAt(dateName, timeName) {
  const d = DATE_DIR.exec(dateName);
  const t = TIME_ENTRY.exec(timeName);
  if (!d || !t) return undefined;
  const [year, month, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [hour, minute, second] = [Number(t[1]), Number(t[2]), Number(t[3])];
  const at = new Date(year, month - 1, day, hour, minute, second);
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== day) {
    return undefined;
  }
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  return at.getTime();
}

/**
 * @param {string} dir
 * @returns {import('node:fs').Dirent[]}
 */
function safeEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * @param {string} runPath
 * @returns {boolean}
 */
function hasKeepMarker(runPath) {
  try {
    if (!statSync(runPath).isDirectory()) return false;
  } catch {
    return false;
  }
  return KEEP_MARKERS.some((marker) => existsSync(path.join(runPath, marker)));
}

/**
 * @param {string} outputsDir
 * @returns {string[]} every `YYYY-MM-DD` folder below `outputsDir`
 */
export function findDateDirs(outputsDir) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of safeEntries(dir)) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      if (DATE_DIR.test(entry.name)) found.push(child);
      else walk(child);
    }
  };
  walk(outputsDir);
  return found.sort();
}

/**
 * @param {{ outputsDir?: string; days?: number; now?: number }} [options]
 * @returns {RetentionPlan}
 */
export function planRetention(options = {}) {
  const outputsDir = options.outputsDir ?? defaultOutputsDir();
  const days = options.days ?? DEFAULT_RETENTION_DAYS;
  const cutoff = (options.now ?? Date.now()) - days * DAY_MS;
  /** @type {RetentionPlan} */
  const plan = { expired: [], kept: [], emptyDateDirs: [], cutoff };
  for (const dateDir of findDateDirs(outputsDir)) {
    const dateName = path.basename(dateDir);
    const entries = safeEntries(dateDir);
    if (entries.length === 0) {
      const endOfDay = runStartedAt(dateName, '23-59-59');
      if (endOfDay !== undefined && endOfDay < cutoff) plan.emptyDateDirs.push(dateDir);
      continue;
    }
    for (const entry of entries) {
      const startedAt = runStartedAt(dateName, entry.name);
      if (startedAt === undefined || startedAt >= cutoff) continue;
      const runPath = path.join(dateDir, entry.name);
      const run = { path: runPath, dateDir, startedAt, kept: hasKeepMarker(runPath) };
      (run.kept ? plan.kept : plan.expired).push(run);
    }
  }
  return plan;
}

/**
 * @param {string} outputsDir
 * @param {string} from
 * @returns {string[]}
 */
function pruneEmptyParents(outputsDir, from) {
  /** @type {string[]} */
  const pruned = [];
  if (!isInside(outputsDir, from) || !pruneEmptyDirs(from)) return pruned;
  pruned.push(from);
  let dir = path.dirname(from);
  while (isInside(outputsDir, dir)) {
    try {
      rmdirSync(dir);
    } catch {
      break;
    }
    pruned.push(dir);
    dir = path.dirname(dir);
  }
  return pruned;
}

/**
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * @param {{ outputsDir?: string; days?: number; now?: number; dryRun?: boolean }} [options]
 * @returns {RetentionResult}
 */
export function applyRetention(options = {}) {
  const outputsDir = options.outputsDir ?? defaultOutputsDir();
  const plan = planRetention({ ...options, outputsDir });
  /** @type {RetentionResult} */
  const result = { plan, removed: [], failed: [], prunedDirs: [] };
  if (options.dryRun) return result;
  for (const run of plan.expired) {
    if (!isInside(outputsDir, run.path)) continue;
    try {
      rmSync(run.path, { recursive: true, force: true });
      result.removed.push(run.path);
    } catch {
      result.failed.push(run.path);
    }
  }
  const parents = new Set([...plan.expired.map((run) => run.dateDir), ...plan.emptyDateDirs]);
  for (const dir of parents) result.prunedDirs.push(...pruneEmptyParents(outputsDir, dir));
  return result;
}

/**
 * @param {string} target
 * @returns {number}
 */
function sizeKiB(target) {
  let bytes = 0;
  /** @param {string} p */
  const walk = (p) => {
    try {
      const stat = statSync(p);
      if (!stat.isDirectory()) {
        bytes += stat.size;
        return;
      }
      for (const entry of safeEntries(p)) walk(path.join(p, entry.name));
    } catch {
      return;
    }
  };
  walk(target);
  return Math.ceil(bytes / 1024);
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ days: number; dryRun: boolean; outputsDir: string }}
 */
export function parseArgs(argv, env) {
  const daysArg = argv.find((a) => a.startsWith('--days='));
  const dirArg = argv.find((a) => a.startsWith('--outputs='));
  return {
    days: parseRetentionDays(daysArg ? daysArg.slice('--days='.length) : env[RETENTION_DAYS_ENV]),
    dryRun: argv.includes('--dry-run'),
    outputsDir: dirArg ? path.resolve(dirArg.slice('--outputs='.length)) : defaultOutputsDir(),
  };
}

function main() {
  /** @type {{ days: number; dryRun: boolean; outputsDir: string }} */
  let args;
  try {
    args = parseArgs(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(`outputs-retention: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
  const { days, dryRun, outputsDir } = args;
  const result = applyRetention({ outputsDir, days, dryRun });
  const { plan } = result;
  const rel = (/** @type {string} */ p) => path.relative(outputsDir, p).split(path.sep).join('/');
  const verb = dryRun ? 'would remove' : 'removed';
  let totalKiB = 0;
  for (const run of plan.expired) {
    const kib = dryRun ? sizeKiB(run.path) : 0;
    totalKiB += kib;
    const done = dryRun || result.removed.includes(run.path);
    console.log(`  [${done ? verb : 'failed'}] ${rel(run.path)}${dryRun ? ` (${kib} KiB)` : ''}`);
  }
  for (const run of plan.kept) console.log(`  [kept: marker] ${rel(run.path)}`);
  for (const dir of plan.emptyDateDirs)
    console.log(`  [${dryRun ? 'would prune' : 'empty'}] ${rel(dir)}/`);
  for (const dir of result.prunedDirs) console.log(`  [pruned] ${rel(dir)}/`);
  const cutoff = new Date(plan.cutoff).toISOString();
  console.log(
    dryRun
      ? `outputs-retention: ${plan.expired.length} run(s) older than ${days} days (before ${cutoff}) would be removed, ${totalKiB} KiB; ${plan.kept.length} kept by a marker; ${plan.emptyDateDirs.length} empty date folder(s) (dry run).`
      : `outputs-retention: removed ${result.removed.length} run(s) older than ${days} days, ${result.failed.length} failed, ${plan.kept.length} kept by a marker, ${result.prunedDirs.length} empty folder(s) pruned.`,
  );
  if (result.failed.length > 0) process.exitCode = 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
