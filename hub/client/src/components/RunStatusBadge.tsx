import type { RunSummary } from '@hub/shared';
import { Box, Group, type MantineSize, Text, Tooltip } from '@mantine/core';

const DOT_SIZE = 8;

import { useT } from '~/i18n/index.js';
import { runOutcome } from '~/utils/run-status.js';

interface RunStatusBadgeProps {
  status: string;
  summary?: RunSummary | null;
  size?: MantineSize;
}

export function RunStatusBadge({ status, summary, size = 'sm' }: RunStatusBadgeProps) {
  const t = useT();
  const outcome = runOutcome(status, summary);
  const label = t(outcome.labelKey);
  return (
    <Tooltip label={label} withArrow>
      <Group gap={8} wrap="nowrap" style={{ flexShrink: 0 }}>
        <Box
          w={DOT_SIZE}
          h={DOT_SIZE}
          bg={`${outcome.color}.6`}
          style={{ borderRadius: '50%', flexShrink: 0 }}
          aria-hidden
        />
        <Text
          size={size}
          fw={outcome.emphasise ? 600 : 500}
          c={outcome.emphasise ? `${outcome.color}.4` : undefined}
          style={{ whiteSpace: 'nowrap' }}
        >
          {label}
        </Text>
      </Group>
    </Tooltip>
  );
}
