import type { ToolId } from '@hub/shared';
import {
  Button,
  Group,
  NumberInput,
  Paper,
  Select,
  Skeleton,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useT } from '~/i18n';
import { usePreferences } from '~/stores/hub.js';

export interface ConcurrencyInfo {
  maxConcurrency: number;
  activeCount: number;
  queueLength: number;
}

export interface ExecutionSettingsProps {
  concurrencyQ: UseQueryResult<ConcurrencyInfo>;
  concurrencyInput: number | '';
  setConcurrencyInput: (value: number | '') => void;
  concurrencyMutation: UseMutationResult<unknown, Error, number>;
  toolOptions: { value: string; label: string }[];
}

export function ExecutionSettings({
  concurrencyQ,
  concurrencyInput,
  setConcurrencyInput,
  concurrencyMutation,
  toolOptions,
}: ExecutionSettingsProps) {
  const t = useT();
  const lastTool = usePreferences((s) => s.lastTool);
  const defaultMode = usePreferences((s) => s.defaultMode);
  const defaultHeadless = usePreferences((s) => s.defaultHeadless);
  const setLastTool = usePreferences((s) => s.setLastTool);
  const setDefaultMode = usePreferences((s) => s.setDefaultMode);
  const setDefaultHeadless = usePreferences((s) => s.setDefaultHeadless);
  return (
    <>
      {/* Execution */}
      <Paper p="md" withBorder>
        <Title order={2} size="h5" mb="sm">
          {t('settings.execution')}
        </Title>
        <Stack gap="sm">
          <Group justify="space-between">
            <Stack gap={2}>
              <Text size="sm">{t('settings.maxConcurrent')}</Text>
              <Text size="xs" c="dimmed">
                {t('settings.maxConcurrentDesc')}
                {concurrencyQ.data && concurrencyQ.data.queueLength > 0 && (
                  <Text span c="blue">
                    {' '}
                    ({concurrencyQ.data.queueLength} {t('settings.queued')})
                  </Text>
                )}
              </Text>
            </Stack>
            {/* Reserve the control's space while the saved value loads —
                  otherwise the input renders empty and then snaps to a number. */}
            {concurrencyQ.isLoading ? (
              <Skeleton height={30} width={132} radius="sm" aria-hidden />
            ) : (
              <Group gap="xs">
                <NumberInput
                  size="xs"
                  w={80}
                  min={1}
                  max={10}
                  value={concurrencyInput}
                  onChange={(v) => setConcurrencyInput(typeof v === 'number' ? v : '')}
                />
                <Button
                  size="xs"
                  onClick={() => {
                    if (typeof concurrencyInput === 'number')
                      concurrencyMutation.mutate(concurrencyInput);
                  }}
                  loading={concurrencyMutation.isPending}
                  disabled={
                    !concurrencyInput || concurrencyInput === concurrencyQ.data?.maxConcurrency
                  }
                >
                  {t('common.save')}
                </Button>
              </Group>
            )}
          </Group>
        </Stack>
      </Paper>

      {/* Run Defaults */}
      <Paper p="md" withBorder>
        <Title order={2} size="h5" mb="sm">
          {t('settings.runDefaults')}
        </Title>
        <Stack gap="sm">
          <Group justify="space-between">
            <Stack gap={2}>
              <Text size="sm">{t('settings.defaultTool')}</Text>
              <Text size="xs" c="dimmed">
                {t('settings.defaultToolDesc')}
              </Text>
            </Stack>
            <Select
              size="xs"
              w={160}
              value={lastTool}
              onChange={(v) => v && setLastTool(v as ToolId)}
              data={toolOptions}
              allowDeselect={false}
            />
          </Group>

          <Group justify="space-between">
            <Stack gap={2}>
              <Text size="sm">{t('settings.defaultMode')}</Text>
              <Text size="xs" c="dimmed">
                {t('settings.defaultModeDesc')}
              </Text>
            </Stack>
            <Select
              size="xs"
              w={140}
              value={defaultMode}
              onChange={(v) => v && setDefaultMode(v as 'local' | 'docker')}
              data={[
                { value: 'local', label: t('run.modeLocal') },
                { value: 'docker', label: 'Docker' },
              ]}
              allowDeselect={false}
            />
          </Group>

          <Group justify="space-between">
            <Stack gap={2}>
              <Text size="sm">{t('settings.defaultDisplay')}</Text>
              <Text size="xs" c="dimmed">
                {t('settings.defaultDisplayDesc')}
              </Text>
            </Stack>
            <Select
              size="xs"
              w={140}
              value={defaultHeadless}
              onChange={(v) => v && setDefaultHeadless(v as 'headless' | 'headed')}
              data={[
                { value: 'headless', label: t('run.headless') },
                { value: 'headed', label: t('run.headed') },
              ]}
              allowDeselect={false}
            />
          </Group>
        </Stack>
      </Paper>
    </>
  );
}
