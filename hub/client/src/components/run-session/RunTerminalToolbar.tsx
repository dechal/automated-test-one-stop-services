import type { RunStatus, RunSummary } from '@hub/shared';
import { ActionIcon, Badge, Button, Group, Text, TextInput, Tooltip } from '@mantine/core';
import type { Dispatch, SetStateAction } from 'react';
import { TbLayoutColumns, TbSearch, TbTextDecrease, TbTextIncrease, TbX } from 'react-icons/tb';
import {
  FONT_MAX,
  FONT_MIN,
  SPLIT_DEFAULT,
} from '~/components/run-session/run-session-constants.js';
import type { RunTerminal } from '~/hooks/useRunTerminal.js';
import { useT } from '~/i18n/index.js';
import { getStatusColor } from '~/utils/run-status.js';
import { runVerdict } from '~/utils/run-verdict.js';

export interface RunTerminalToolbarProps {
  advancedMode: boolean;
  isRunning: boolean;
  isFinished: boolean;
  elapsed: string;
  runStatus: RunStatus | 'idle';
  runSummary: RunSummary | null;
  fontSize: number;
  setTerminalFontSize: (size: number) => void;
  splitPercent: number;
  setRunSplitPercent: (percent: number) => void;
  searchOpen: boolean;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  searchTerm: string;
  setSearchTerm: (value: string) => void;
  term: RunTerminal;
}

export function RunTerminalToolbar({
  advancedMode,
  isRunning,
  isFinished,
  elapsed,
  runStatus,
  runSummary,
  fontSize,
  setTerminalFontSize,
  splitPercent,
  setRunSplitPercent,
  searchOpen,
  setSearchOpen,
  searchTerm,
  setSearchTerm,
  term,
}: RunTerminalToolbarProps) {
  const t = useT();
  return (
    <>
      <Group
        justify="space-between"
        px="sm"
        py={6}
        style={{ borderBottom: '1px solid var(--mantine-color-default-border)', flexShrink: 0 }}
      >
        <Group gap="xs">
          <Text size="xs" c="dimmed">
            {advancedMode ? t('run.liveOutput') : t('run.technicalOutput')}
          </Text>
          {isRunning && elapsed && (
            <Text size="xs" c="blue" ff="monospace">
              {elapsed}
            </Text>
          )}
          {isFinished && (
            <Text size="xs" fw={600} c={getStatusColor(runStatus)}>
              {runVerdict(runSummary, t)}
            </Text>
          )}
          {!isRunning && runSummary && (
            <Group gap={6}>
              {runSummary.passed > 0 && (
                <Badge size="xs" color="green" variant="light">
                  {runSummary.passed} {t('run.passed')}
                </Badge>
              )}
              {runSummary.failed > 0 && (
                <Badge size="xs" color="red" variant="light">
                  {runSummary.failed} {t('run.failed')}
                </Badge>
              )}
              {runSummary.skipped !== undefined && runSummary.skipped > 0 && (
                <Badge size="xs" color="yellow" variant="light">
                  {runSummary.skipped} {t('run.skipped')}
                </Badge>
              )}
            </Group>
          )}
        </Group>
        <Group gap="xs">
          {advancedMode && (
            <Badge
              size="sm"
              color={getStatusColor(runStatus)}
              variant={runStatus === 'running' ? 'dot' : 'filled'}
            >
              {runStatus}
            </Badge>
          )}
          {/* One control, so the pair sits tighter than the row's gap. Both
              ends disable at the store's clamp rather than clicking to no
              effect. */}
          <Group gap={2} wrap="nowrap">
            <Tooltip label={`${t('run.terminalFontSize')} −`} withArrow>
              <ActionIcon
                size="sm"
                variant="subtle"
                color="gray"
                onClick={() => setTerminalFontSize(fontSize - 1)}
                disabled={fontSize <= FONT_MIN}
                aria-label={`${t('run.terminalFontSize')} −`}
              >
                <TbTextDecrease size={14} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={`${t('run.terminalFontSize')} +`} withArrow>
              <ActionIcon
                size="sm"
                variant="subtle"
                color="gray"
                onClick={() => setTerminalFontSize(fontSize + 1)}
                disabled={fontSize >= FONT_MAX}
                aria-label={`${t('run.terminalFontSize')} +`}
              >
                <TbTextIncrease size={14} />
              </ActionIcon>
            </Tooltip>
          </Group>
          <Tooltip label={t('run.resetSplit')} withArrow>
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              visibleFrom="md"
              onClick={() => setRunSplitPercent(SPLIT_DEFAULT)}
              disabled={splitPercent === SPLIT_DEFAULT}
              aria-label={t('run.resetSplit')}
            >
              <TbLayoutColumns size={14} />
            </ActionIcon>
          </Tooltip>
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            onClick={() => setSearchOpen((v) => !v)}
            leftSection={<TbSearch size={12} />}
          >
            {t('run.find')}
          </Button>
        </Group>
      </Group>
      {searchOpen && (
        <Group
          px="sm"
          py={4}
          gap="xs"
          style={{
            borderBottom: '1px solid var(--mantine-color-default-border)',
            flexShrink: 0,
          }}
        >
          <TextInput
            size="xs"
            placeholder={t('run.searchOutput')}
            value={searchTerm}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setSearchTerm(v);
              if (v) term.findNext(v);
              else term.clearSearch();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (e.shiftKey) term.findPrevious(searchTerm);
                else term.findNext(searchTerm);
              }
              if (e.key === 'Escape') {
                setSearchOpen(false);
                term.clearSearch();
              }
            }}
            leftSection={<TbSearch size={12} />}
            rightSection={
              searchTerm ? (
                <TbX
                  size={12}
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    setSearchTerm('');
                    term.clearSearch();
                  }}
                />
              ) : null
            }
            style={{ flex: 1 }}
            autoFocus
          />
          <Text size="xs" c="dimmed">
            {t('run.searchHint')}
          </Text>
        </Group>
      )}
    </>
  );
}
