import type { ProjectSummary } from '@hub/shared';
import { Alert, Checkbox, Code, Progress, Stack, Text, TextInput } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { TbAlertTriangle, TbCircleCheck, TbPackage } from 'react-icons/tb';
import { api } from '~/api/client.js';
import { formatSize } from '~/components/artifacts/ArtifactViews.js';
import { FormModal } from '~/components/FormModal.js';
import { type CiChoice, CiProviderSelect } from '~/components/projects/CiProviderSelect.js';
import { toast } from '~/components/Toast.js';
import { useT } from '~/i18n/index.js';

const JOB_POLL_MS = 2_000;

interface BundleJobStart {
  jobId: string;
}

interface BundleJob {
  jobId: string;
  status: 'running' | 'done' | 'failed';
  stage: string | null;
  stageIndex: number;
  stageCount: number;
  result?: {
    result: {
      targetDir: string;
      sizeBytes: number;
      zipPath?: string;
      ciFiles?: string[];
      zipError?: { code: string; message: string };
    };
  };
  error?: { code: string; message: string };
}

interface BundleModalProps {
  target: ProjectSummary | null;
  onClose: () => void;
}

export function BundleModal({ target, onClose }: BundleModalProps) {
  const t = useT();
  const [targetDir, setTargetDir] = useState('');
  const [withEnv, setWithEnv] = useState(false);
  const [zip, setZip] = useState(false);
  const [ci, setCi] = useState<CiChoice>('none');
  const [jobId, setJobId] = useState<string | null>(null);

  useEffect(() => {
    if (target) {
      setTargetDir('');
      setWithEnv(false);
      setZip(false);
      setCi('none');
      setJobId(null);
    }
  }, [target]);

  const start = useMutation<BundleJobStart>({
    mutationFn: () =>
      api.post<BundleJobStart>('/api/projects/bundle', {
        tool: target?.tool,
        type: target?.type,
        project: target?.name,
        targetDir: targetDir.trim(),
        withEnv,
        zip,
        ci,
      }),
    onSuccess: (res) => setJobId(res.jobId),
  });

  const job = useQuery<BundleJob>({
    queryKey: ['bundle-job', jobId],
    queryFn: () => api.get<BundleJob>(`/api/projects/bundle/${jobId}`),
    enabled: jobId !== null,
    retry: false,
    refetchInterval: (query) =>
      query.state.status === 'error' || (query.state.data && query.state.data.status !== 'running')
        ? false
        : JOB_POLL_MS,
  });

  const status = job.data?.status;
  useEffect(() => {
    if (status === 'done') toast.success(t('bundleModal.done'));
  }, [status, t]);

  const running = start.isPending || (jobId !== null && !job.isError && status !== 'failed');
  const startError = start.isError ? (start.error as Error).message : null;
  const jobError = job.isError
    ? t('bundleModal.jobLost')
    : job.data?.error
      ? `${t('bundleModal.failed')}: ${job.data.error.code} — ${job.data.error.message}`
      : null;
  const output = job.data?.result?.result;

  return (
    <FormModal
      opened={target !== null}
      onClose={onClose}
      title={t('bundleModal.title')}
      submitLabel={t('bundleModal.button')}
      onSubmit={() => {
        setJobId(null);
        start.mutate();
      }}
      submitDisabled={!targetDir.trim() || running}
      loading={running && status !== 'done'}
      error={startError ?? jobError}
    >
      <Text size="sm" c="dimmed">
        {t('bundleModal.desc')}
      </Text>
      {target && <Code block>{`${target.tool}/${target.type}/${target.name}`}</Code>}
      <TextInput
        label={t('bundleModal.targetLabel')}
        description={t('bundleModal.targetDesc')}
        leftSection={<TbPackage size={14} />}
        value={targetDir}
        onChange={(e) => setTargetDir(e.currentTarget.value)}
        placeholder={t('bundleModal.targetPlaceholder')}
        disabled={running}
      />
      <Checkbox
        label={t('bundleModal.withEnv')}
        checked={withEnv}
        onChange={(e) => setWithEnv(e.currentTarget.checked)}
        disabled={running}
      />
      {withEnv && (
        <Alert color="yellow" variant="light" icon={<TbAlertTriangle size={16} />} p="xs">
          <Text size="xs">{t('bundleModal.withEnvWarn')}</Text>
        </Alert>
      )}
      <Checkbox
        label={t('bundleModal.zip')}
        checked={zip}
        onChange={(e) => setZip(e.currentTarget.checked)}
        disabled={running}
      />
      <CiProviderSelect value={ci} onChange={setCi} disabled={running} />
      <Text size="xs" c="dimmed">
        {t('bundleModal.sizeNote')}
      </Text>
      {jobId !== null && status === 'running' && job.data && (
        <Stack gap={4}>
          <Text size="sm">
            {job.data.stage
              ? t('bundleModal.stage')
                  .replace('{n}', String(job.data.stageIndex))
                  .replace('{total}', String(job.data.stageCount))
                  .replace('{stage}', job.data.stage)
              : t('bundleModal.starting')}
          </Text>
          <Progress
            value={job.data.stageCount ? (job.data.stageIndex / job.data.stageCount) * 100 : 0}
            animated
            aria-label={t('bundleModal.title')}
          />
        </Stack>
      )}
      {status === 'done' && output && (
        <Alert color="green" variant="light" icon={<TbCircleCheck size={16} />} p="xs">
          <Stack gap={2}>
            <Text size="sm" fw={500}>
              {t('bundleModal.done')}
            </Text>
            <Text size="xs" style={{ overflowWrap: 'anywhere' }}>
              {t('bundleModal.folder')}: <Code>{output.targetDir}</Code>
            </Text>
            {output.zipPath && (
              <Text size="xs" style={{ overflowWrap: 'anywhere' }}>
                {t('bundleModal.zipFile')}: <Code>{output.zipPath}</Code>
              </Text>
            )}
            <Text size="xs">
              {t('bundleModal.size')}: {formatSize(output.sizeBytes)}
            </Text>
            {output.ciFiles && (
              <Text size="xs" style={{ overflowWrap: 'anywhere' }}>
                {t('ciSelect.files')}: <Code>{output.ciFiles.join(', ')}</Code>
              </Text>
            )}
            {output.zipError && (
              <Text size="xs" c="yellow">
                {t('bundleModal.zipFailed')} {output.zipError.message}
              </Text>
            )}
          </Stack>
        </Alert>
      )}
    </FormModal>
  );
}
