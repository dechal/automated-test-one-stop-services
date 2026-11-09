import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Indicator,
  Menu,
  Paper,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  TbAlertTriangle,
  TbBrandGit,
  TbCircleCheck,
  TbCircleX,
  TbDots,
  TbDownload,
  TbFolder,
  TbPackage,
  TbPackageExport,
  TbPencil,
  TbTrash,
} from 'react-icons/tb';
import { api } from '~/api/client.js';
import { toast } from '~/components/Toast.js';
import { useT } from '~/i18n/index.js';
import { formatAbsolute } from '~/utils/datetime.js';
import { getStatusColor, statusLabelKey } from '~/utils/run-status.js';

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
  onMakeStandalone?: () => void;
  onExportBundle?: () => void;
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
  onMakeStandalone,
  onExportBundle,
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
                aria-label={`${t('projectRow.openGitRepo')} ${name}`}
                onClick={(e) => e.stopPropagation()}
              >
                <TbBrandGit size={14} />
              </ActionIcon>
            </Tooltip>
          )}
          {isGit && !gitRemoteUrl && <TbBrandGit size={14} color="var(--mantine-color-dimmed)" />}
          {status === 'no-env' && (
            <Group gap={4} wrap="nowrap" c="red.4">
              <TbCircleX size={14} />
              <Text size="xs" c="red.4" style={{ whiteSpace: 'nowrap' }}>
                {t('projectRow.noEnv')}
              </Text>
            </Group>
          )}
          {status === 'missing' && (
            <Group gap={4} wrap="nowrap" c="yellow.4">
              <TbAlertTriangle size={14} />
              <Text size="xs" c="yellow.4" style={{ whiteSpace: 'nowrap' }}>
                {t('projectRow.envMissing')}
              </Text>
            </Group>
          )}
          {status === 'ready' && (
            <Group gap={4} wrap="nowrap" c="dimmed">
              <TbCircleCheck size={14} />
              <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                {t('projectRow.ready')}
              </Text>
            </Group>
          )}
          {lastRun && (
            <Tooltip label={`${t('projectRow.lastRun')} ${formatAbsolute(lastRun.endedAt)}`}>
              <Badge size="xs" variant="dot" color={getStatusColor(lastRun.status)}>
                {t(statusLabelKey(lastRun.status))}
              </Badge>
            </Tooltip>
          )}
        </Group>
        <Group gap={8} wrap="nowrap">
          {isGit && onPull && (
            <Indicator color="red" size={8} offset={4} withBorder disabled={!hasUpdate}>
              <Button
                size="compact-xs"
                variant={hasUpdate ? 'light' : 'subtle'}
                color={hasUpdate ? undefined : 'gray'}
                onClick={onPull}
                loading={isPulling}
                leftSection={<TbDownload size={12} />}
              >
                {t('projectRow.pull')}
              </Button>
            </Indicator>
          )}
          <Button
            size="compact-xs"
            variant="default"
            onClick={onEdit}
            leftSection={<TbPencil size={12} />}
          >
            .env
          </Button>
          {(projectPath || onMakeStandalone || onExportBundle || onRemove) && (
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="gray"
                  aria-label={`${t('projectRow.moreActions')} ${name}`}
                >
                  <TbDots size={16} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {projectPath && (
                  <Menu.Item leftSection={<TbFolder size={14} />} onClick={handleReveal}>
                    {t('projectRow.reveal')}
                  </Menu.Item>
                )}
                {onMakeStandalone && (
                  <Menu.Item leftSection={<TbPackageExport size={14} />} onClick={onMakeStandalone}>
                    {t('projectRow.makeStandalone')}
                  </Menu.Item>
                )}
                {onExportBundle && (
                  <Menu.Item leftSection={<TbPackage size={14} />} onClick={onExportBundle}>
                    {t('projectRow.exportBundle')}
                  </Menu.Item>
                )}
                {onRemove && (
                  <>
                    <Menu.Divider />
                    <Menu.Item color="red" leftSection={<TbTrash size={14} />} onClick={onRemove}>
                      {t('projectRow.remove')}
                    </Menu.Item>
                  </>
                )}
              </Menu.Dropdown>
            </Menu>
          )}
        </Group>
      </Group>
    </Paper>
  );
}
