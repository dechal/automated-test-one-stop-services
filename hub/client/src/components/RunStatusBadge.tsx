import type { RunSummary } from '@hub/shared';
import { Badge, type MantineSize, Tooltip } from '@mantine/core';
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
      <Badge
        color={outcome.color}
        variant={outcome.emphasise ? 'filled' : 'light'}
        size={size}
        leftSection={outcome.icon}
        style={{ flexShrink: 0 }}
        styles={{ label: { overflow: 'visible' } }}
      >
        {label}
      </Badge>
    </Tooltip>
  );
}
