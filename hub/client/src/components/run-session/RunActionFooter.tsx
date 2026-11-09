import { ActionIcon, Button, Group, Stack, Text, Tooltip } from '@mantine/core';
import { TbBookmarkPlus, TbPlayerPlay, TbPlayerStop } from 'react-icons/tb';
import { useT } from '~/i18n/index.js';

export interface RunActionFooterProps {
  supportsTags: boolean;
  project: string;
  effectiveType: string;
  tagsIsLoading: boolean;
  missingReqs: string[];
  isRunning: boolean;
  isMobile: boolean;
  appiumRunning: boolean;
  handleRun: () => void;
  runLabel: string;
  runPending: boolean;
  handleCancel: () => void;
  saveBookmarkReason: string | null;
  handleSaveBookmark: () => void;
  saveBookmarkPending: boolean;
}

export function RunActionFooter({
  supportsTags,
  project,
  effectiveType,
  tagsIsLoading,
  missingReqs,
  isRunning,
  isMobile,
  appiumRunning,
  handleRun,
  runLabel,
  runPending,
  handleCancel,
  saveBookmarkReason,
  handleSaveBookmark,
  saveBookmarkPending,
}: RunActionFooterProps) {
  const t = useT();
  const tagsLoading = supportsTags && !!project && !!effectiveType && tagsIsLoading;
  const disabledReason =
    missingReqs.length > 0
      ? `${t('run.missingRequirements')}: ${missingReqs.join(', ')}`
      : !project
        ? t('run.selectProjectFirst')
        : isRunning
          ? t('run.testRunning')
          : tagsLoading
            ? t('run.loadingTags')
            : isMobile && !appiumRunning
              ? t('run.appiumNotRunning')
              : null;
  const showReason = !!disabledReason && !isRunning;
  return (
    <Stack gap={8} style={{ flexShrink: 0 }}>
      {showReason && (
        <Text size="xs" c="dimmed" ta="center" role="status">
          {disabledReason}
        </Text>
      )}
      <Group gap="xs">
        <Tooltip label={disabledReason ?? t('run.runTooltip')} disabled={!disabledReason} withArrow>
          {/* Wrapper div is required so Tooltip can show on a disabled button. */}
          <div style={{ flex: 1 }}>
            <Button
              size="md"
              color="green.8"
              fullWidth
              onClick={handleRun}
              loading={runPending}
              disabled={!!disabledReason}
              leftSection={<TbPlayerPlay size={16} />}
              rightSection={
                <Text span ff="monospace" fz={11} c="inherit" opacity={0.7}>
                  Ctrl+Enter
                </Text>
              }
            >
              <Text span truncate fw={500} fz="sm">
                {runLabel}
              </Text>
            </Button>
          </div>
        </Tooltip>
        {isRunning && (
          <Button
            size="md"
            color="red"
            onClick={handleCancel}
            leftSection={<TbPlayerStop size={16} />}
            style={{ flex: 'none' }}
          >
            {t('run.stop')}
          </Button>
        )}
        {/* Saves the same live config the Bookmarks panel captures, next to the
          form instead of in the panel at the top of the page. */}
        <Tooltip label={saveBookmarkReason ?? t('bookmark.saveCurrent')} withArrow>
          {/* Wrapper div is required so Tooltip can show on a disabled control. */}
          <div style={{ flex: 'none' }}>
            <ActionIcon
              size="input-md"
              variant="default"
              onClick={handleSaveBookmark}
              loading={saveBookmarkPending}
              disabled={!!saveBookmarkReason}
              aria-label={t('bookmark.saveCurrent')}
            >
              <TbBookmarkPlus size={18} />
            </ActionIcon>
          </div>
        </Tooltip>
      </Group>
    </Stack>
  );
}
