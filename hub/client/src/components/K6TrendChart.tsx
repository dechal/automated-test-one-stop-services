import type { K6RunSummary } from '@hub/shared';
import { AreaChart, LineChart } from '@mantine/charts';
import { Group, Stack, Text } from '@mantine/core';
import dayjs from 'dayjs';
import { useT } from '~/i18n/index.js';

interface ChartRow {
  label: string;
  p95: number;
  p99: number;
  avg: number;
  rps: number;
  errorRate: number;
}

/**
 * Response-time + throughput/error trend across a k6 project's runs (oldest to
 * newest, left to right). Runs arrive newest-first, so reverse for the timeline.
 * One point per run, keyed by the run's timestamp.
 */
export function K6TrendChart({ runs }: { runs: K6RunSummary[] }) {
  const t = useT();
  const rows: ChartRow[] = [...runs].reverse().map((run) => {
    const m = run.metrics[run.metrics.length - 1];
    return {
      label: dayjs(run.timestamp).format('DD/MM HH:mm'),
      p95: Math.round(m?.p95ResponseTime ?? 0),
      p99: Math.round(m?.p99ResponseTime ?? 0),
      avg: Math.round(m?.avgResponseTime ?? 0),
      rps: Math.round((m?.rps ?? 0) * 10) / 10,
      errorRate: Math.round((m?.errorRate ?? 0) * 100) / 100,
    };
  });

  // A single run is a point, not a trend — a line chart of one value reads as
  // empty. Need at least two runs for a meaningful timeline.
  if (rows.length < 2) {
    return (
      <Text size="xs" c="dimmed">
        {t('perf.trendNeedsMore')}
      </Text>
    );
  }

  return (
    <Stack gap="lg">
      <div>
        <Text size="xs" fw={600} c="dimmed" tt="uppercase" mb={4}>
          {t('perf.trendResponseTime')}
        </Text>
        <AreaChart
          h={200}
          data={rows}
          dataKey="label"
          withDots={false}
          curveType="monotone"
          unit=" ms"
          withLegend
          series={[
            { name: 'avg', label: t('perf.avgResponse'), color: 'blue.5' },
            { name: 'p95', label: 'P95', color: 'orange.5' },
            { name: 'p99', label: 'P99', color: 'red.5' },
          ]}
        />
      </div>
      <Group grow align="flex-start">
        <div>
          <Text size="xs" fw={600} c="dimmed" tt="uppercase" mb={4}>
            {t('perf.trendThroughput')}
          </Text>
          <LineChart
            h={160}
            data={rows}
            dataKey="label"
            withDots={false}
            curveType="monotone"
            series={[{ name: 'rps', label: 'RPS', color: 'teal.5' }]}
          />
        </div>
        <div>
          <Text size="xs" fw={600} c="dimmed" tt="uppercase" mb={4}>
            {t('perf.trendError')}
          </Text>
          <LineChart
            h={160}
            data={rows}
            dataKey="label"
            withDots={false}
            curveType="monotone"
            unit="%"
            series={[{ name: 'errorRate', label: t('perf.errorRate'), color: 'red.6' }]}
          />
        </div>
      </Group>
    </Stack>
  );
}
