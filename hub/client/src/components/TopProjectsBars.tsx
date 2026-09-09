import type { RunRecord } from '@hub/shared';
import { BarsList, type BarsListBarData } from '@mantine/charts';
import { SegmentedControl, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '~/api/client.js';

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
  const [mode, setMode] = useState<Mode>('project');

  const history = useQuery<RunRecord[]>({
    queryKey: ['runs-history'],
    queryFn: () => api.get('/api/runs/history'),
  });

  const data = useMemo(() => aggregate(history.data ?? [], mode), [history.data, mode]);

  if (history.isLoading) {
    return (
      <Text c="dimmed" size="sm">
        Loading...
      </Text>
    );
  }

  if (data.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        No runs yet.
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
          { value: 'project', label: 'By Project' },
          { value: 'tool', label: 'By Tool' },
        ]}
      />
      <BarsList
        data={data}
        valueFormatter={(v) => `${v} run${v === 1 ? '' : 's'}`}
        styles={{
          bar: { overflow: 'hidden' },
          barLabel: { whiteSpace: 'nowrap', overflow: 'visible' },
        }}
      />
    </Stack>
  );
}
