import type { RunRecord, RunRequest, RunStatus } from '@hub/shared';
import { Badge, Button, Code, Group, Modal, ScrollArea, Stack, Text } from '@mantine/core';
import { TbCopy, TbExternalLink, TbPlayerPlay, TbTerminal } from 'react-icons/tb';
import { api } from '~/api/client.js';
import { ArtifactMenu } from '~/components/reports/ArtifactMenu.js';
import { toast } from '~/components/Toast.js';
import { translate, useT } from '~/i18n/index.js';
import { formatAbsolute, formatDurationBetween } from '~/utils/datetime.js';

function statusColor(s: RunStatus | string): string {
  if (s === 'passed') return 'green';
  if (s === 'failed') return 'red';
  if (s === 'cancelled') return 'orange';
  if (s === 'running') return 'blue';
  return 'gray';
}

/** Open a run's HTML report in the OS default app (same path as the Reports page). */
async function openReport(reportPath: string): Promise<void> {
  try {
    await api.post('/api/reports/open-file', { path: reportPath });
  } catch {
    toast.error(translate('runlog.openReportFailed'));
  }
}

export interface RunLogModalProps {
  run: RunRecord | null;
  opened: boolean;
  onClose: () => void;
  onRerun: (config: RunRequest) => void;
}

/**
 * Modal that shows a single run's metadata and command.
 * Extracted from `pages/History.tsx` to keep that page focused on the table.
 */
export function RunLogModal({ run, opened, onClose, onRerun }: RunLogModalProps) {
  const t = useT();
  if (!run) return null;
  const { reportPath } = run;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="sm">
          <TbTerminal size={16} />
          <Text size="sm" fw={600}>
            Run Details — {run.request.project}
          </Text>
          <Badge size="xs" color={statusColor(run.status)}>
            {run.status}
          </Badge>
        </Group>
      }
      size="xl"
      centered
      scrollAreaComponent={ScrollArea.Autosize}
    >
      <Stack gap="sm">
        <Group gap="xl" wrap="wrap">
          <Stack gap={2}>
            <Text size="xs" c="dimmed">
              {t('run.tool')}
            </Text>
            <Text size="xs" fw={500}>
              {run.request.tool}
            </Text>
          </Stack>
          <Stack gap={2}>
            <Text size="xs" c="dimmed">
              {t('table.type')}
            </Text>
            <Text size="xs" fw={500}>
              {run.request.type}
            </Text>
          </Stack>
          <Stack gap={2}>
            <Text size="xs" c="dimmed">
              {t('table.duration')}
            </Text>
            <Text size="xs" fw={500}>
              {formatDurationBetween(run.startedAt, run.endedAt)}
            </Text>
          </Stack>
          <Stack gap={2}>
            <Text size="xs" c="dimmed">
              {t('runlog.exitCode')}
            </Text>
            <Text size="xs" fw={500} c={run.exitCode === 0 ? 'green' : 'red'}>
              {run.exitCode ?? 'N/A'}
            </Text>
          </Stack>
          <Stack gap={2}>
            <Text size="xs" c="dimmed">
              {t('table.started')}
            </Text>
            <Text size="xs" fw={500}>
              {formatAbsolute(run.startedAt)}
            </Text>
          </Stack>
          {run.endedAt && (
            <Stack gap={2}>
              <Text size="xs" c="dimmed">
                {t('runlog.ended')}
              </Text>
              <Text size="xs" fw={500}>
                {formatAbsolute(run.endedAt)}
              </Text>
            </Stack>
          )}
        </Group>

        {reportPath && (
          <Group gap="xs">
            <Button
              size="compact-xs"
              variant="light"
              color="blue"
              leftSection={<TbExternalLink size={12} />}
              onClick={() => openReport(reportPath)}
            >
              {t('runlog.openReport')}
            </Button>
            <ArtifactMenu reportPath={reportPath} />
          </Group>
        )}

        <Stack gap={4}>
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              {t('runlog.command')}
            </Text>
            <Group gap={4}>
              <Button
                size="compact-xs"
                variant="light"
                color="green"
                leftSection={<TbPlayerPlay size={12} />}
                onClick={() => {
                  onRerun(run.request);
                  onClose();
                }}
              >
                {t('runlog.rerun')}
              </Button>
              <Button
                size="compact-xs"
                variant="light"
                color="gray"
                leftSection={<TbCopy size={12} />}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(run.command);
                    toast.success(t('runlog.commandCopied'));
                  } catch {
                    toast.error(t('common.copyFailed'));
                  }
                }}
              >
                {t('common.copy')}
              </Button>
            </Group>
          </Group>
          <Code block style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {run.command}
          </Code>
        </Stack>

        {run.request.tag && (
          <Stack gap={4}>
            <Text size="xs" c="dimmed">
              {t('runlog.tags')}
            </Text>
            <Code style={{ fontSize: 11 }}>{run.request.tag}</Code>
          </Stack>
        )}

        {run.request.extraArgs && (
          <Stack gap={4}>
            <Text size="xs" c="dimmed">
              Extra Args
            </Text>
            <Code style={{ fontSize: 11 }}>{run.request.extraArgs}</Code>
          </Stack>
        )}

        <Text size="xs" c="dimmed" mt="sm">
          Note: Live terminal output is only kept for active sessions — past run logs are not
          persisted. For a finished run, open its report (when available) for failure details.
        </Text>
      </Stack>
    </Modal>
  );
}
