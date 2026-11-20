import { type ReportNameError, renderReportName, validateReportName } from '@hub/shared';
import { Checkbox, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import type { TranslationKey } from '~/i18n/en.js';
import { useT } from '~/i18n/index.js';

const REPORT_EXTENSION = '.html';

const ERROR_KEYS: Record<ReportNameError, TranslationKey> = {
  empty: 'schedule.cloneNameErrEmpty',
  tooLong: 'schedule.cloneNameErrTooLong',
  forbiddenChar: 'schedule.cloneNameErrForbidden',
  controlChar: 'schedule.cloneNameErrForbidden',
  reserved: 'schedule.cloneNameErrReserved',
  trailingDotOrSpace: 'schedule.cloneNameErrTrailing',
};

export function cloneReportNameError(template: string): ReportNameError | undefined {
  return validateReportName(renderReportName(template, new Date()));
}

export interface CloneReportFieldProps {
  enabled: boolean;
  template: string;
  disabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onTemplateChange: (template: string) => void;
}

export function CloneReportField({
  enabled,
  template,
  disabled,
  onEnabledChange,
  onTemplateChange,
}: CloneReportFieldProps) {
  const t = useT();
  const active = enabled && !disabled;
  const error = active ? cloneReportNameError(template) : undefined;
  const preview = `${renderReportName(template, new Date())}${REPORT_EXTENSION}`;

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
          error={error ? t(ERROR_KEYS[error]) : undefined}
          description={
            error
              ? t('schedule.cloneReportTokens')
              : `${t('schedule.cloneReportPreview')} ${preview}`
          }
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
        />
      )}
      {active && !error && (
        <Text size="xs" c="dimmed">
          {t('schedule.cloneReportTokens')}
        </Text>
      )}
    </Stack>
  );
}
