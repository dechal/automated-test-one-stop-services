import {
  type ReportDirError,
  renderReportName,
  reportDirError,
  reportNameError,
} from '@hub/shared';
import { Checkbox, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import type { TranslationKey } from '~/i18n/en.js';
import { useT } from '~/i18n/index.js';
import { ReportDestinationMenu } from './ReportDestinationMenu.js';

const REPORT_EXTENSION = '.html';

const ERROR_KEYS: Record<ReportDirError, TranslationKey> = {
  empty: 'schedule.cloneNameErrEmpty',
  tooLong: 'schedule.cloneNameErrTooLong',
  forbiddenChar: 'schedule.cloneNameErrForbidden',
  controlChar: 'schedule.cloneNameErrForbidden',
  reserved: 'schedule.cloneNameErrReserved',
  trailingDotOrSpace: 'schedule.cloneNameErrTrailing',
  badFormula: 'schedule.cloneErrFormula',
  notAbsolute: 'schedule.cloneDirErrNotAbsolute',
};

export function cloneReportInvalid(nameTemplate: string, dirTemplate: string): boolean {
  const now = new Date();
  return (
    reportNameError(nameTemplate, now) !== undefined ||
    (dirTemplate.trim() !== '' && reportDirError(dirTemplate, now) !== undefined)
  );
}

export interface CloneReportFieldProps {
  enabled: boolean;
  template: string;
  dirTemplate: string;
  disabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onTemplateChange: (template: string) => void;
  onDirTemplateChange: (dirTemplate: string) => void;
}

export function CloneReportField({
  enabled,
  template,
  dirTemplate,
  disabled,
  onEnabledChange,
  onTemplateChange,
  onDirTemplateChange,
}: CloneReportFieldProps) {
  const t = useT();
  const now = new Date();
  const active = enabled && !disabled;
  const nameError = active ? reportNameError(template, now) : undefined;
  const hasDir = dirTemplate.trim() !== '';
  const dirError = active && hasDir ? reportDirError(dirTemplate, now) : undefined;
  const namePreview = `${renderReportName(template, now) ?? ''}${REPORT_EXTENSION}`;
  const dirPreview = hasDir ? renderReportName(dirTemplate, now) : undefined;

  return (
    <Stack gap={6}>
      <Tooltip label={t('schedule.cloneReportHint')} withArrow multiline w={280}>
        <Checkbox
          size="xs"
          label={t('schedule.cloneReport')}
          disabled={disabled}
          checked={active}
          onChange={(e) => onEnabledChange(e.currentTarget.checked)}
        />
      </Tooltip>
      {active && (
        <>
          <TextInput
            size="xs"
            label={t('schedule.cloneReportName')}
            value={template}
            onChange={(e) => onTemplateChange(e.currentTarget.value)}
            placeholder="report_%d-%m-%Y"
            rightSection={
              <Text size="xs" c="dimmed" ff="monospace">
                {REPORT_EXTENSION}
              </Text>
            }
            rightSectionWidth={48}
            error={nameError ? t(ERROR_KEYS[nameError]) : undefined}
            description={
              nameError ? undefined : `${t('schedule.cloneReportPreview')} ${namePreview}`
            }
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
          />
          <TextInput
            size="xs"
            label={t('schedule.cloneReportDir')}
            value={dirTemplate}
            onChange={(e) => onDirTemplateChange(e.currentTarget.value)}
            placeholder={t('schedule.cloneReportDirPlaceholder')}
            rightSection={
              <ReportDestinationMenu value={dirTemplate} onPick={onDirTemplateChange} />
            }
            error={dirError ? t(ERROR_KEYS[dirError]) : undefined}
            description={
              dirError
                ? undefined
                : dirPreview
                  ? `${t('schedule.cloneReportDirPreview')} ${dirPreview}`
                  : t('schedule.cloneReportDirEmpty')
            }
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
          />
          <Text size="xs" c="dimmed">
            {t('schedule.cloneReportTokens')}
          </Text>
          <Text size="xs" c="dimmed">
            {t('schedule.cloneReportFormula')}
          </Text>
        </>
      )}
    </Stack>
  );
}
