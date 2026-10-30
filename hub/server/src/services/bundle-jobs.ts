import { randomUUID } from 'node:crypto';
import type { LifecycleResult } from '@hub/shared';
import type { BundleExportResult, ExportError } from './export-module.js';

export const BUNDLE_JOB_RETENTION_MS = 60 * 60 * 1000;

export type BundleJobStatus = 'running' | 'done' | 'failed';

export type BundleJobOutcome = ExportError | LifecycleResult<BundleExportResult>;

export interface BundleJobView {
  readonly jobId: string;
  readonly status: BundleJobStatus;
  readonly stage: string | null;
  readonly stageIndex: number;
  readonly stageCount: number;
  readonly result?: LifecycleResult<BundleExportResult>;
  readonly error?: ExportError;
}

interface BundleJob {
  view: BundleJobView;
  finishedAt: number | null;
}

const jobs = new Map<string, BundleJob>();

function prune(now: number): void {
  for (const [id, job] of jobs) {
    if (job.finishedAt !== null && now - job.finishedAt >= BUNDLE_JOB_RETENTION_MS) {
      jobs.delete(id);
    }
  }
}

export function hasRunningBundleJob(): boolean {
  for (const job of jobs.values()) {
    if (job.view.status === 'running') return true;
  }
  return false;
}

export function startBundleJob(
  stages: readonly string[],
  run: (onStage: (stage: string) => void) => Promise<BundleJobOutcome>,
  now: () => number = Date.now,
): string | null {
  prune(now());
  if (hasRunningBundleJob()) return null;
  const jobId = randomUUID();
  const job: BundleJob = {
    view: { jobId, status: 'running', stage: null, stageIndex: 0, stageCount: stages.length },
    finishedAt: null,
  };
  jobs.set(jobId, job);

  const onStage = (stage: string): void => {
    job.view = { ...job.view, stage, stageIndex: stages.indexOf(stage) + 1 };
  };
  const finish = (patch: Partial<BundleJobView>): void => {
    job.view = { ...job.view, ...patch };
    job.finishedAt = now();
  };

  void Promise.resolve()
    .then(() => run(onStage))
    .then(
      (outcome) => {
        if ('code' in outcome) {
          finish({ status: 'failed', error: { code: outcome.code, message: outcome.message } });
        } else {
          finish({ status: 'done', result: outcome });
        }
      },
      (err: unknown) => {
        finish({
          status: 'failed',
          error: {
            code: 'EXPORT_FAILED',
            message: err instanceof Error ? err.message : String(err),
          },
        });
      },
    );
  return jobId;
}

export function getBundleJob(jobId: string, now: number = Date.now()): BundleJobView | null {
  prune(now);
  return jobs.get(jobId)?.view ?? null;
}
