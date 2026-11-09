import { Group, Text, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { qRunsHistory } from '~/api/queries.js';
import { PassScoreCell } from '~/components/PassScoreCell.js';
import { RunStatusBadge } from '~/components/RunStatusBadge.js';
import { useT } from '~/i18n/index.js';
import { formatAbsolute, formatRelative } from '~/utils/datetime.js';

interface RunLastRunProps {
  tool: string;
  type: string;
  project: string;
}

export function RunLastRun({ tool, type, project }: RunLastRunProps) {
  const t = useT();
  const history = useQuery(qRunsHistory());

  const last = (history.data ?? [])
    .filter(
      (r) =>
        r.endedAt &&
        r.request.tool === tool &&
        r.request.project === project &&
        (!type || r.request.type === type),
    )
    .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))[0];

  if (!project || !last?.endedAt) return null;

  return (
    <Group
      gap="sm"
      wrap="nowrap"
      px="sm"
      py={8}
      style={{ borderBottom: '1px solid var(--mantine-color-default-border)', flexShrink: 0 }}
    >
      <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
        {t('run.lastRun')}
      </Text>
      <RunStatusBadge status={last.status} summary={last.summary} size="xs" />
      <PassScoreCell summary={last.summary} severity={last.severity} />
      <Tooltip label={formatAbsolute(last.endedAt)} withArrow>
        <Text size="xs" c="dimmed" ml="auto" style={{ whiteSpace: 'nowrap' }}>
          {formatRelative(last.endedAt)}
        </Text>
      </Tooltip>
    </Group>
  );
}
