import { ActionIcon, Button, Code, Group, Text, Tooltip } from '@mantine/core';
import { TbCopy, TbExternalLink, TbFolder, TbRefresh, TbTrash } from 'react-icons/tb';
import { useT } from '~/i18n/index.js';

export interface RunResultBarProps {
  advancedMode: boolean;
  isRunning: boolean;
  lastCommand: string;
  elapsed: string;
  reportPath: string | undefined;
  reportFavorite: boolean | undefined;
  handleCopyCommand: () => void;
  handleSeeReport: () => void;
  handleRevealReport: () => void;
  handleDeleteReport: () => void;
  handleRerun: () => void;
}

export function RunResultBar({
  advancedMode,
  isRunning,
  lastCommand,
  elapsed,
  reportPath,
  reportFavorite,
  handleCopyCommand,
  handleSeeReport,
  handleRevealReport,
  handleDeleteReport,
  handleRerun,
}: RunResultBarProps) {
  const t = useT();
  return (
    <Group
      gap="xs"
      wrap="nowrap"
      justify={advancedMode ? 'space-between' : 'flex-end'}
      style={{ flexShrink: 0 }}
    >
      {advancedMode && (
        <Group gap={4} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
          <Code
            fz="xs"
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {lastCommand}
          </Code>
          <Tooltip label={t('run.copy')} withArrow>
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              onClick={handleCopyCommand}
              aria-label={t('run.copy')}
              style={{ flexShrink: 0 }}
            >
              <TbCopy size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      )}
      <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
        {!isRunning && elapsed && (
          <Text size="xs" c="dimmed">
            {t('run.duration')}: {elapsed}
          </Text>
        )}
        {!isRunning && reportPath && (
          <>
            <Button
              size="sm"
              variant="subtle"
              color="blue"
              onClick={handleSeeReport}
              leftSection={<TbExternalLink size={16} />}
            >
              {t('runlog.openReport')}
            </Button>
            <Tooltip label={t('run.revealReportHint')} withArrow>
              <Button
                size="sm"
                variant="subtle"
                color="gray"
                onClick={handleRevealReport}
                leftSection={<TbFolder size={16} />}
              >
                {t('run.revealReport')}
              </Button>
            </Tooltip>
            <Tooltip label={t('reports.favoriteLockedHint')} withArrow disabled={!reportFavorite}>
              <Button
                size="sm"
                variant="subtle"
                color="red"
                onClick={handleDeleteReport}
                disabled={reportFavorite}
                leftSection={<TbTrash size={16} />}
              >
                {t('run.deleteReport')}
              </Button>
            </Tooltip>
          </>
        )}
        {!isRunning && (
          <Button
            size="sm"
            variant="subtle"
            onClick={handleRerun}
            leftSection={<TbRefresh size={16} />}
          >
            {t('run.rerun')}
          </Button>
        )}
      </Group>
    </Group>
  );
}
