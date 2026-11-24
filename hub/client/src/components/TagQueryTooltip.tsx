import { Stack, Text } from '@mantine/core';
import { useT } from '~/i18n/index.js';
import { describeTagQuery } from '~/utils/tag-describe.js';

export function TagQueryTooltip({ tool, expr }: { tool: string; expr: string | undefined }) {
  const t = useT();
  const { include, exclude } = describeTagQuery(tool, expr);
  const andWord = ` ${t('schedule.tagAnd')} `;
  const orWord = ` ${t('schedule.tagOr')} `;
  const includeText = include
    .map((group) => (group.length > 1 ? `(${group.join(orWord)})` : (group[0] ?? '')))
    .join(andWord);

  return (
    <Stack gap={4}>
      <Text size="xs">
        <Text span size="xs" fw={700} c="teal.3">
          {t('schedule.tagInclude')}:
        </Text>{' '}
        {includeText || t('schedule.tagAll')}
      </Text>
      {exclude.length > 0 && (
        <Text size="xs">
          <Text span size="xs" fw={700} c="red.3">
            {t('schedule.tagExclude')}:
          </Text>{' '}
          {exclude.join(', ')}
        </Text>
      )}
    </Stack>
  );
}
