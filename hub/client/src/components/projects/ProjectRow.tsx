import { ActionIcon, Badge, Button, Group, Indicator, Paper, Text, Tooltip } from '@mantine/core';
import {
  TbAlertTriangle,
  TbBrandGit,
  TbCircleCheck,
  TbCircleX,
  TbDownload,
  TbFolder,
  TbPencil,
  TbTrash,
} from 'react-icons/tb';
import { api } from '~/api/client.js';
import { toast } from '~/components/Toast.js';
import { useT } from '~/i18n/index.js';

export interface LastRunInfo {
  status: string;
  endedAt: string;
}

export type ProjectRowStatus = 'ready' | 'no-env' | 'missing';

interface ProjectRowProps {
  name: string;
  isGit?: boolean;
  gitRemoteUrl?: string;
  projectPath?: string;
  status: ProjectRowStatus;
  lastRun?: LastRunInfo;
  onEdit: () => void;
  onPull?: () => void;
  isPulling?: boolean;
  hasUpdate?: boolean;
  /** When provided, renders a destructive "remove project" action. */
  onRemove?: () => void;
}

/** Convert a git remote URL to its web-viewable equivalent. */
function toWebUrl(url: string): string {
  return url.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '');
}

/**
 * Single project row inside a ToolSection: name, env status, last run
 * outcome, and the per-row actions (Pull, Reveal, edit .env).
 */
export function ProjectRow({
  name,
  isGit,
  gitRemoteUrl,
  projectPath,
  status,
  lastRun,
  onEdit,
  onPull,
  isPulling,
  hasUpdate,
  onRemove,
}: ProjectRowProps) {
  const t = useT();

  async function handleReveal() {
    if (!projectPath) return;
    try {
      await api.post('/api/system/reveal', { path: projectPath });
    } catch (err) {
      toast.error((err as Error).message || t('projectRow.revealFailed'));
    }
  }

  return (
    <Paper p="xs" radius="sm" bg="var(--mantine-color-default-hover)" withBorder>
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Tooltip label={name} openDelay={400}>
            <Text size="sm" fw={500} truncate>
              {name}
            </Text>
          </Tooltip>
          {isGit && gitRemoteUrl && (
            <Tooltip label={gitRemoteUrl}>
              <ActionIcon
                component="a"
                href={toWebUrl(gitRemoteUrl)}
                target="_blank"
                rel="noopener noreferrer"
                variant="subtle"
                size="sm"
                onClick={(e) => e.stopPropagation()}
              >
                <TbBrandGit size={14} />
              </ActionIcon>
            </Tooltip>
          )}
          {isGit && !gitRemoteUrl && <TbBrandGit size={14} color="var(--mantine-color-dimmed)" />}
          {status === 'no-env' && (
            <Badge size="xs" color="red" leftSection={<TbCircleX size={10} />}>
              {t('projectRow.noEnv')}
            </Badge>
          )}
          {status === 'missing' && (
            <Badge size="xs" color="yellow" leftSection={<TbAlertTriangle size={10} />}>
              {t('projectRow.envMissing')}
            </Badge>
          )}
          {status === 'ready' && (
            <Badge size="xs" color="green" leftSection={<TbCircleCheck size={10} />}>
              {t('projectRow.ready')}
            </Badge>
          )}
          {lastRun && (
            <Tooltip
              label={`${t('projectRow.lastRun')} ${new Date(lastRun.endedAt).toLocaleString()}`}
            >
              <Badge
                size="xs"
                variant="dot"
                color={
                  lastRun.status === 'passed'
                    ? 'green'
                    : lastRun.status === 'failed'
                      ? 'red'
                      : 'yellow'
                }
              >
                {lastRun.status}
              </Badge>
            </Tooltip>
          )}
        </Group>
        <Group gap={4} wrap="nowrap">
          {isGit && onPull && (
            <Indicator color="red" size={12} offset={4} processing withBorder disabled={!hasUpdate}>
              <Button
                size="compact-xs"
                color="grape"
                onClick={onPull}
                loading={isPulling}
                leftSection={<TbDownload size={12} />}
              >
                {t('projectRow.pull')}
              </Button>
            </Indicator>
          )}
          {projectPath && (
            <Tooltip label={t('projectRow.reveal')} withArrow>
              <ActionIcon
                size="sm"
                variant="subtle"
                color="gray"
                onClick={handleReveal}
                aria-label={t('projectRow.reveal')}
              >
                <TbFolder size={14} />
              </ActionIcon>
            </Tooltip>
          )}
          <Button
            size="compact-xs"
            variant="default"
            onClick={onEdit}
            leftSection={<TbPencil size={12} />}
          >
            .env
          </Button>
          {onRemove && (
            <Tooltip label={t('projectRow.remove')} withArrow>
              <ActionIcon
                size="sm"
                variant="subtle"
                color="red"
                onClick={onRemove}
                aria-label={t('projectRow.remove')}
              >
                <TbTrash size={14} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      </Group>
    </Paper>
  );
}
