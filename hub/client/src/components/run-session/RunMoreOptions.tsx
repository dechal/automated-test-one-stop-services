import type { HeadlessMode, RunMode } from '@hub/shared';
import {
  Checkbox,
  Collapse,
  Group,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { TbChevronRight, TbSettings } from 'react-icons/tb';
import { useT } from '~/i18n/index.js';

export interface RunMoreOptionsProps {
  moreOpen: boolean;
  toggleMore: () => void;
  isRunning: boolean;
  advancedMode: boolean;
  optionFieldCount: number;
  dockerRunning: boolean | undefined;
  forceTrack: boolean | undefined;
  sectionAxis: boolean;
  hasDisplay: boolean;
  supportsRunFlags: boolean;
  reportSurvives: boolean;
  mode: RunMode;
  setMode: (value: RunMode) => void;
  headless: HeadlessMode;
  setHeadless: (value: HeadlessMode) => void;
  workers: number | null;
  setWorkers: (value: number | null) => void;
  repeatEach: number | null;
  setRepeatEach: (value: number | null) => void;
  extraArgs: string;
  setExtraArgs: (value: string) => void;
  noTrack: boolean;
  setNoTrack: (value: boolean) => void;
  silent: boolean;
  setSilent: (value: boolean) => void;
  discardReport: boolean;
  setDiscardReport: (value: boolean) => void;
  autoOpenReport: boolean;
  setAutoOpenReport: (value: boolean) => void;
}

export function RunMoreOptions({
  moreOpen,
  toggleMore,
  isRunning,
  advancedMode,
  optionFieldCount,
  dockerRunning,
  forceTrack,
  sectionAxis,
  hasDisplay,
  supportsRunFlags,
  reportSurvives,
  mode,
  setMode,
  headless,
  setHeadless,
  workers,
  setWorkers,
  repeatEach,
  setRepeatEach,
  extraArgs,
  setExtraArgs,
  noTrack,
  setNoTrack,
  silent,
  setSilent,
  discardReport,
  setDiscardReport,
  autoOpenReport,
  setAutoOpenReport,
}: RunMoreOptionsProps) {
  const t = useT();
  return (
    <Stack gap="xs">
      <UnstyledButton
        onClick={toggleMore}
        aria-expanded={moreOpen}
        aria-label={t('run.moreOptions')}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          borderTop: '1px solid var(--mantine-color-default-border)',
          paddingTop: 'var(--mantine-spacing-xs)',
        }}
      >
        <TbChevronRight
          size={14}
          style={{
            transform: moreOpen ? 'rotate(90deg)' : 'none',
            transition: 'transform 150ms ease',
            opacity: 0.6,
          }}
        />
        <TbSettings size={14} style={{ opacity: 0.7 }} />
        <Text size="xs" fw={600} c="dimmed">
          {t('run.moreOptions')}
        </Text>
        {!moreOpen && (
          <Text size="xs" c="dimmed">
            ({t('run.moreOptionsCollapsed')})
          </Text>
        )}
      </UnstyledButton>
      <Collapse expanded={moreOpen}>
        <Stack gap="xs">
          {/* Row 2 — HOW to run. Mode, display and the tuning numbers share one
              line; each was a near-empty block of its own before. */}
          <SimpleGrid
            cols={{ base: 1, xs: 2, md: Math.min(3, Math.max(2, optionFieldCount)) }}
            spacing="sm"
          >
            {/* Docker needs a running daemon and knowledge of the compose
                setup, so basic mode neither shows it nor uses it —
                `effectiveMode` pins the run to local. A visible-but-ignored
                select would be the worse half-measure. */}
            {advancedMode && (
              <Select
                label={t('run.mode')}
                size="xs"
                disabled={isRunning}
                value={mode}
                onChange={(v) => v && setMode(v as RunMode)}
                data={[
                  { value: 'local', label: t('run.modeLocal') },
                  {
                    value: 'docker',
                    label: `Docker${!dockerRunning ? ` (${t('run.notRunning')})` : ''}`,
                    disabled: !dockerRunning,
                  },
                ]}
                allowDeselect={false}
              />
            )}
            {!sectionAxis && hasDisplay && (
              <Select
                label={t('run.display')}
                size="xs"
                disabled={isRunning}
                value={headless}
                onChange={(v) => v && setHeadless(v as HeadlessMode)}
                data={[
                  { value: 'headless', label: t('run.headless') },
                  { value: 'headed', label: t('run.headed') },
                ]}
                allowDeselect={false}
              />
            )}
            {!sectionAxis && supportsRunFlags && (
              <>
                <NumberInput
                  label={t('run.workers')}
                  size="xs"
                  min={1}
                  max={64}
                  disabled={isRunning}
                  value={workers ?? ''}
                  onChange={(v: string | number) => setWorkers(typeof v === 'number' ? v : null)}
                  placeholder={t('run.autoDefault')}
                />
                <NumberInput
                  label={t('run.repeatEach')}
                  size="xs"
                  min={1}
                  max={50}
                  disabled={isRunning}
                  value={repeatEach ?? ''}
                  onChange={(v: string | number) => setRepeatEach(typeof v === 'number' ? v : null)}
                  placeholder="1"
                />
              </>
            )}
            {advancedMode && !sectionAxis && (
              <TextInput
                label={t('run.extraArgs')}
                size="xs"
                disabled={isRunning}
                value={extraArgs}
                onChange={(e) => setExtraArgs(e.currentTarget.value)}
                placeholder="--debug"
              />
            )}
          </SimpleGrid>

          <Group gap="lg" wrap="wrap">
            {!forceTrack && (
              <Checkbox
                size="xs"
                label={t('run.skipUsageLogging')}
                disabled={isRunning}
                checked={noTrack}
                onChange={(e) => setNoTrack(e.currentTarget.checked)}
              />
            )}

            <Checkbox
              size="xs"
              label={t('run.silentMode')}
              disabled={isRunning}
              checked={silent}
              onChange={(e) => setSilent(e.currentTarget.checked)}
            />

            {/* Silent already discards the report, so the narrower option
                is redundant (and misleading) while it is on. */}
            <Tooltip label={t('run.discardReportHint')} withArrow multiline w={280}>
              <Checkbox
                size="xs"
                label={t('run.discardReport')}
                disabled={isRunning || silent}
                checked={discardReport && !silent}
                onChange={(e) => setDiscardReport(e.currentTarget.checked)}
              />
            </Tooltip>

            {/* Only useful when a report survives the run; disabled (and
                force-read as off) under silent / discard so it never
                promises to open a report that will not exist. */}
            <Tooltip label={t('run.openReportAfterHint')} withArrow multiline w={280}>
              <Checkbox
                size="xs"
                label={t('run.openReportAfter')}
                disabled={isRunning || !reportSurvives}
                checked={autoOpenReport && reportSurvives}
                onChange={(e) => setAutoOpenReport(e.currentTarget.checked)}
              />
            </Tooltip>
          </Group>

          {!advancedMode && (
            <Text size="xs" c="dimmed">
              {t('run.adminOptionsNote')}
            </Text>
          )}
        </Stack>
      </Collapse>
    </Stack>
  );
}
