import { Group, Stack, Text, useComputedColorScheme } from '@mantine/core';
import { useT } from '~/i18n/index.js';
import { describeTagQuery } from '~/utils/tag-describe.js';

export function TagQueryTooltip({ tool, expr }: { tool: string; expr: string | undefined }) {
  const t = useT();
  const scheme = useComputedColorScheme('dark');
  const shade = scheme === 'dark' ? 8 : 3;
  const { include, exclude } = describeTagQuery(tool, expr);
  const andWord = ` ${t('schedule.tagAnd')} `;
  const orWord = ` ${t('schedule.tagOr')} `;
  const includeText = include
    .map((group) => (group.length > 1 ? `(${group.join(orWord)})` : (group[0] ?? '')))
    .join(andWord);
  return (
    <Stack gap={4}>
      <Group gap={6} align="flex-start" wrap="nowrap">
        <Text size="xs" fw={700} c={`teal.${shade}`} miw={52}>
          {t('schedule.tagInclude')}
        </Text>
        <Text size="xs">{includeText || t('schedule.tagAll')}</Text>
      </Group>
      {exclude.length > 0 && (
        <Group gap={6} align="flex-start" wrap="nowrap">
          <Text size="xs" fw={700} c={`red.${shade}`} miw={52}>
            {t('schedule.tagExclude')}
          </Text>
          <Text size="xs">{exclude.join(', ')}</Text>
        </Group>
      )}
    </Stack>
  );
}
