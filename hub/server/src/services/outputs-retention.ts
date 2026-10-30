import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { OUTPUTS_DIR, WORKSPACE_ROOT } from '../config.js';

interface RetentionRun {
  path: string;
  dateDir: string;
  startedAt: number;
  kept: boolean;
}

interface RetentionPlan {
  expired: RetentionRun[];
  kept: RetentionRun[];
  emptyDateDirs: string[];
  cutoff: number;
}

interface RetentionResult {
  plan: RetentionPlan;
  removed: string[];
  failed: string[];
  prunedDirs: string[];
}

interface RetentionOptions {
  outputsDir?: string;
  days?: number;
  now?: number;
  dryRun?: boolean;
}

interface RetentionModule {
  planRetention(options?: RetentionOptions): RetentionPlan;
  applyRetention(options?: RetentionOptions): RetentionResult;
}

const RUNNER_PATH = path.resolve(WORKSPACE_ROOT, 'scripts', 'lib', 'outputs-retention.mjs');

let runner: Promise<RetentionModule> | null = null;

function loadRunner(): Promise<RetentionModule> {
  if (runner) return runner;
  runner = (import(pathToFileURL(RUNNER_PATH).href) as Promise<RetentionModule>).catch((err) => {
    runner = null;
    throw err;
  });
  return runner;
}

export interface SweepResult {
  planned: number;
  removed: string[];
  failed: string[];
}

export async function sweepOutputs(
  days: number,
  outputsDir: string = OUTPUTS_DIR,
  now: number = Date.now(),
): Promise<SweepResult> {
  const mod = await loadRunner();
  const plan = mod.planRetention({ outputsDir, days, now });
  if (plan.expired.length === 0 && plan.emptyDateDirs.length === 0) {
    return { planned: 0, removed: [], failed: [] };
  }
  const result = mod.applyRetention({ outputsDir, days, now });
  return { planned: plan.expired.length, removed: result.removed, failed: result.failed };
}
