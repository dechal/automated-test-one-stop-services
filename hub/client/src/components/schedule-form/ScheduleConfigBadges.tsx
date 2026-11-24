import { type RunRequest, renderReportName } from '@hub/shared';
import { Box, Group, Tooltip } from '@mantine/core';
import type { ReactNode } from 'react';
import {
  TbAppWindow,
  TbBrandDocker,
  TbCopy,
  TbFileX,
  TbFolderShare,
  TbNotesOff,
  TbTerminal2,
  TbVolumeOff,
} from 'react-icons/tb';
import { useT } from '~/i18n/index.js';

const ICON_SIZE = 14;
const BADGE_SIZE = 22;
const REPORT_EXTENSION = '.html';

interface ConfigBadge {
  key: string;
  icon: ReactNode;
  color: string;
  label: string;
}

export function ScheduleConfigBadges({ config }: { config: RunRequest }) {
  const t = useT();
  const now = new Date();
  const badges: ConfigBadge[] = [];

  if (config.cloneReportName) {
    const name = renderReportName(config.cloneReportName, now) ?? config.cloneReportName;
    badges.push({
      key: 'clone',
      icon: <TbCopy size={ICON_SIZE} />,
      color: 'teal',
      label: `${t('schedule.badgeClone')}: ${name}${REPORT_EXTENSION}`,
    });
  }
  if (config.cloneReportDir) {
    const dir = renderReportName(config.cloneReportDir, now) ?? config.cloneReportDir;
    badges.push({
      key: 'clone-dir',
      icon: <TbFolderShare size={ICON_SIZE} />,
      color: 'teal',
      label: `${t('schedule.badgeCloneDir')}: ${dir}`,
    });
  }
  if (config.silent) {
    badges.push({
      key: 'silent',
      icon: <TbVolumeOff size={ICON_SIZE} />,
      color: 'gray',
      label: t('run.silentMode'),
    });
  }
  if (config.discardReport) {
    badges.push({
      key: 'discard',
      icon: <TbFileX size={ICON_SIZE} />,
      color: 'orange',
      label: t('run.discardReport'),
    });
  }
  if (config.noTrack) {
    badges.push({
      key: 'no-track',
      icon: <TbNotesOff size={ICON_SIZE} />,
      color: 'gray',
      label: t('run.skipUsageLogging'),
    });
  }
  if (config.mode === 'docker') {
    badges.push({
      key: 'docker',
      icon: <TbBrandDocker size={ICON_SIZE} />,
      color: 'blue',
      label: t('schedule.badgeDocker'),
    });
  }
  if (config.headless === 'headed') {
    badges.push({
      key: 'headed',
      icon: <TbAppWindow size={ICON_SIZE} />,
      color: 'violet',
      label: t('schedule.badgeHeaded'),
    });
  }
  if (config.extraArgs?.trim()) {
    badges.push({
      key: 'args',
      icon: <TbTerminal2 size={ICON_SIZE} />,
      color: 'grape',
      label: `${t('run.extraArgs')}: ${config.extraArgs.trim()}`,
    });
  }

  if (badges.length === 0) return null;

  return (
    <Group
      gap={2}
      wrap="nowrap"
      px={4}
      py={2}
      style={{
        borderRadius: 'var(--mantine-radius-xl)',
        background: 'var(--mantine-color-default-hover)',
      }}
    >
      {badges.map((badge) => (
        <Tooltip key={badge.key} label={badge.label} withArrow multiline maw={420}>
          <Box
            tabIndex={0}
            aria-label={badge.label}
            c={`${badge.color}.5`}
            style={{
              width: BADGE_SIZE,
              height: BADGE_SIZE,
              display: 'grid',
              placeItems: 'center',
              borderRadius: '50%',
            }}
          >
            {badge.icon}
          </Box>
        </Tooltip>
      ))}
    </Group>
  );
}
