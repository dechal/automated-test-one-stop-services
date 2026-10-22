import type { RunRecord } from '@hub/shared';
import { BarsList, type BarsListBarData } from '@mantine/charts';
import { SegmentedControl, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '~/api/client.js';
import { useT } from '~/i18n/index.js';

type Mode = 'project' | 'tool';

function aggregate(records: RunRecord[], mode: Mode): BarsListBarData[] {
  const map = new Map<string, { count: number }>();
  for (const r of records) {
    const key = mode === 'project' ? `${r.request.tool}/${r.request.project}` : r.request.tool;
    const entry = map.get(key) ?? { count: 0 };
    entry.count++;
    map.set(key, entry);
  }
  return [...map.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 8)
    .map(([name, info]) => ({
      name,
      value: info.count,
      color: 'blue',
    }));
}

export function TopProjectsBars() {
  const t = useT();
  const [mode, setMode] = useState<Mode>('project');

  const history = useQuery<RunRecord[]>({
    queryKey: ['runs-history'],
    queryFn: () => api.get('/api/runs/history'),
  });

  const data = useMemo(() => aggregate(history.data ?? [], mode), [history.data, mode]);

  if (history.isLoading) {
    return (
      <Text c="dimmed" size="sm">
        {t('common.loading')}
      </Text>
    );
  }

  if (data.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        {t('chart.noRuns')}
      </Text>
    );
  }

  return (
    <Stack gap="xs">
      <SegmentedControl
        size="xs"
        value={mode}
        onChange={(v) => setMode(v as Mode)}
        data={[
          { value: 'project', label: t('chart.byProject') },
          { value: 'tool', label: t('chart.byTool') },
        ]}
      />
      <BarsList
        data={data}
        valueFormatter={(v) =>
          t(v === 1 ? 'chart.runCountOne' : 'chart.runCount').replace('{n}', String(v))
        }
        styles={{
          bar: { overflow: 'hidden' },
          barLabel: { whiteSpace: 'nowrap', overflow: 'visible' },
        }}
      />
    </Stack>
  );
}
