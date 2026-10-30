import { beforeEach, describe, expect, it, vi } from 'vitest';

type BundleJobsModule = typeof import('../bundle-jobs.js');

const STAGES = ['validate', 'copy-project', 'zip'] as const;

const RESULT = {
  result: {
    tool: 'k6',
    type: 'performance',
    project: 'demo',
    targetDir: 'C:\\out\\demo',
    mode: 'fresh' as const,
    written: [],
    kind: 'bundle' as const,
    platform: 'win32-x64',
    runtimes: { k6: '2.0.0' },
    entry: null,
    sizeBytes: 1,
    envIncluded: false,
  },
  resynced: false,
  regeneratedFiles: [],
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('bundle-jobs', () => {
  let jobs: BundleJobsModule;

  beforeEach(async () => {
    vi.resetModules();
    jobs = await import('../bundle-jobs.js');
  });

  it('tracks stages and finishes as done', async () => {
    const gate = deferred<typeof RESULT>();
    let report: (stage: string) => void = () => {};
    const jobId = jobs.startBundleJob(STAGES, (onStage) => {
      report = onStage;
      return gate.promise;
    });
    expect(jobId).not.toBeNull();
    await flush();
    report('copy-project');
    expect(jobs.getBundleJob(jobId ?? '')).toMatchObject({
      status: 'running',
      stage: 'copy-project',
      stageIndex: 2,
      stageCount: 3,
    });
    gate.resolve(RESULT);
    await flush();
    expect(jobs.getBundleJob(jobId ?? '')).toMatchObject({ status: 'done', result: RESULT });
  });

  it('refuses a second job while one runs', async () => {
    const gate = deferred<typeof RESULT>();
    expect(jobs.startBundleJob(STAGES, () => gate.promise)).not.toBeNull();
    expect(jobs.hasRunningBundleJob()).toBe(true);
    expect(jobs.startBundleJob(STAGES, () => gate.promise)).toBeNull();
    gate.resolve(RESULT);
    await flush();
    expect(jobs.hasRunningBundleJob()).toBe(false);
    expect(jobs.startBundleJob(STAGES, async () => RESULT)).not.toBeNull();
  });

  it('records an export error code as failed', async () => {
    const jobId = jobs.startBundleJob(STAGES, async () => ({
      code: 'RUNTIME_FETCH_FAILED',
      message: 'boom',
    }));
    await flush();
    expect(jobs.getBundleJob(jobId ?? '')).toMatchObject({
      status: 'failed',
      error: { code: 'RUNTIME_FETCH_FAILED', message: 'boom' },
    });
  });

  it('records a thrown error as EXPORT_FAILED', async () => {
    const jobId = jobs.startBundleJob(STAGES, async () => {
      throw new Error('disk full');
    });
    await flush();
    expect(jobs.getBundleJob(jobId ?? '')).toMatchObject({
      status: 'failed',
      error: { code: 'EXPORT_FAILED', message: 'disk full' },
    });
  });

  it('drops a finished job after the retention window', async () => {
    const start = 1_000;
    const jobId = jobs.startBundleJob(
      STAGES,
      async () => RESULT,
      () => start,
    );
    await flush();
    const id = jobId ?? '';
    expect(jobs.getBundleJob(id, start + jobs.BUNDLE_JOB_RETENTION_MS - 1)).not.toBeNull();
    expect(jobs.getBundleJob(id, start + jobs.BUNDLE_JOB_RETENTION_MS)).toBeNull();
  });

  it('returns null for an unknown id', () => {
    expect(jobs.getBundleJob('nope')).toBeNull();
  });
});
