import { Box, Group, Stack, Text, useComputedColorScheme } from '@mantine/core';

export type StatTone = 'good' | 'bad' | 'neutral';

export interface StatRow {
  label: string;
  value: string;
  tone?: StatTone;
}

const TONE_COLOR: Record<Exclude<StatTone, 'neutral'>, string> = { good: 'teal', bad: 'red' };

/**
 * Shared structured tooltip body: a bold title, label/value rows and an
 * optional footnote. Tooltips are light on the dark theme and dark on the
 * light theme, so tones pick a shade that reads on that surface.
 */
export function StatTooltip({
  title,
  detail,
  rows = [],
  footer,
}: {
  title: string;
  detail?: string;
  rows?: StatRow[];
  footer?: string;
}) {
  const scheme = useComputedColorScheme('dark');
  const toneColor = (tone: StatTone | undefined): string | undefined =>
    !tone || tone === 'neutral' ? undefined : `${TONE_COLOR[tone]}.${scheme === 'dark' ? 8 : 3}`;
  return (
    <Stack gap={4} miw={150}>
      <Text size="xs" fw={700}>
        {title}
      </Text>
      {detail && (
        <Text size="xs" ff="monospace" style={{ wordBreak: 'break-all' }}>
          {detail}
        </Text>
      )}
      {rows.length > 0 && (
        <Box>
          {rows.map((row) => (
            <Group key={row.label} justify="space-between" gap="lg" wrap="nowrap">
              <Text size="xs" opacity={0.75}>
                {row.label}
              </Text>
              <Text size="xs" fw={600} ff="monospace" c={toneColor(row.tone)}>
                {row.value}
              </Text>
            </Group>
          ))}
        </Box>
      )}
      {footer && (
        <Text size="xs" opacity={0.75}>
          {footer}
        </Text>
      )}
    </Stack>
  );
}
