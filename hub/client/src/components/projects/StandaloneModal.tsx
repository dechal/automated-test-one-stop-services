import type { ProjectSummary } from '@hub/shared';
import { Code, Text, TextInput } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { TbPackageExport } from 'react-icons/tb';
import { api } from '~/api/client.js';
import { FormModal } from '~/components/FormModal.js';
import { type CiChoice, CiProviderSelect } from '~/components/projects/CiProviderSelect.js';
import { toast } from '~/components/Toast.js';
import { useT } from '~/i18n/index.js';

interface StandaloneResult {
  success: boolean;
  code?: string;
  message?: string;
  output?: {
    mode: 'fresh' | 'migrate';
    written: string[];
    ciFiles?: string[];
    installError?: { code: string; message: string };
  };
}

interface StandaloneModalProps {
  target: ProjectSummary | null;
  onClose: () => void;
  onSuccess: () => void;
}

export function StandaloneModal({ target, onClose, onSuccess }: StandaloneModalProps) {
  const t = useT();
  const [targetDir, setTargetDir] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ci, setCi] = useState<CiChoice>('none');

  useEffect(() => {
    if (target) {
      setTargetDir('');
      setError(null);
      setCi('none');
    }
  }, [target]);

  const mutation = useMutation<StandaloneResult>({
    mutationFn: () =>
      api.post<StandaloneResult>('/api/projects/standalone', {
        tool: target?.tool,
        type: target?.type,
        project: target?.name,
        targetDir,
        ci,
      }),
    onSuccess: (res) => {
      if (!res.success) {
        setError(res.message ?? t('projects.standaloneFailed'));
        return;
      }
      if (res.output?.installError) {
        toast.error(t('projects.standaloneInstallWarn'));
      } else {
        toast.success(
          res.output?.mode === 'migrate'
            ? t('projects.standaloneUpdated')
            : t('projects.standaloneDone'),
        );
      }
      if (res.output?.ciFiles) {
        toast.success(`${t('ciSelect.files')}: ${res.output.ciFiles.join(', ')}`);
      }
      onSuccess();
    },
  });

  const trimmed = targetDir.trim();
  const mutationError = mutation.isError ? (mutation.error as Error).message : null;

  return (
    <FormModal
      opened={target !== null}
      onClose={onClose}
      title={t('projects.standaloneTitle')}
      submitLabel={t('projects.standaloneButton')}
      onSubmit={() => {
        setError(null);
        mutation.mutate();
      }}
      submitDisabled={!trimmed || mutation.isPending}
      loading={mutation.isPending}
      error={error ?? mutationError}
    >
      <Text size="sm" c="dimmed">
        {t('projects.standaloneDesc')}
      </Text>
      {target && <Code block>{`${target.tool}/${target.type}/${target.name}`}</Code>}
      <TextInput
        label={t('projects.standaloneTargetLabel')}
        description={t('projects.standaloneTargetDesc')}
        leftSection={<TbPackageExport size={14} />}
        value={targetDir}
        onChange={(e) => setTargetDir(e.currentTarget.value)}
        placeholder={t('projects.standaloneTargetPlaceholder')}
      />
      <CiProviderSelect value={ci} onChange={setCi} disabled={mutation.isPending} />
    </FormModal>
  );
}
