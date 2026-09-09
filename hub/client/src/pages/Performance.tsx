import type { K6RunSummary, K6TrendData } from '@hub/shared';
import { Badge, Button, Card, Paper, Select, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { TbAlertTriangle, TbChartLine, TbCheck, TbRefresh, TbX } from 'react-icons/tb';
import { api } from '~/api/client';
import { EmptyState } from '~/components/EmptyState.js';
import { InlineAlert } from '~/components/InlineAlert.js';
import { PageHeader } from '~/components/PageHeader.js';
import { StatCardsSkeleton } from '~/components/Skeletons.js';
import { toast } from '~/components/Toast';
import { useProjectList } from '~/hooks/useProjectQueries.js';
import { useTools } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';

/**
 * A k6 run's metrics are a time-series; the stored summary writes a single
 * end-of-test point (services/k6-trends.ts `parseK6Summary`). Reduce a run to
 * that representative point for the trend table + summary cards.
 */
function runPoint(run: K6RunSummary) {
  const m = run.metrics[run.metrics.length - 1];
  return {
    runId: run.runId,
    avg: m?.avgResponseTime ?? 0,
    p95: m?.p95ResponseTime ?? 0,
    p99: m?.p99ResponseTime ?? 0,
    rps: m?.rps ?? 0,
    errorRate: m?.errorRate ?? 0,
  };
}

export function PerformancePage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [selectedProject, setSelectedProject] = useState<string | null>(null);

  // List ALL k6 projects from the real project scanner (not only those already
  // present in k6-trends.json), so every project is selectable; one with no
  // scanned runs yet shows the "no data" empty state until Refresh finds a run.
  const projectsQ = useProjectList('k6', 'performance');
  const projectNames = projectsQ.data ?? [];
  const toolsQuery = useTools();
  const k6Installed = (toolsQuery.data ?? []).some(
    (tv) => tv.id === 'k6' && tv.status === 'enabled',
  );

  const trends = useQuery<K6TrendData>({
    queryKey: ['k6-trends', selectedProject],
    queryFn: () => api.get(`/api/k6-trends/${selectedProject}`),
    enabled: !!selectedProject,
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.post('/api/k6-trends/refresh'),
    onSuccess: () => {
      toast.success(t('performance.refreshed'));
      queryClient.invalidateQueries({ queryKey: ['k6-trends'] });
      queryClient.invalidateQueries({ queryKey: ['k6-projects'] });
    },
    onError: () => toast.error(t('performance.refreshFailed')),
  });

  // Service returns runs newest-first; runs[0] is the latest run.
  const runs = trends.data?.runs ?? [];
  const latest = runs[0] ? runPoint(runs[0]) : undefined;
  const latestThresholds = runs[0]?.thresholds ?? [];

  return (
    <Stack gap="md">
      <PageHeader
        title={t('nav.performance')}
        actions={
          <>
            <Select
              size="xs"
              placeholder={t('filter.selectProject')}
              value={selectedProject}
              onChange={setSelectedProject}
              data={projectNames}
              searchable
              w={200}
            />
            <Button
              leftSection={<TbRefresh size={14} />}
              size="xs"
              variant="light"
              onClick={() => refreshMutation.mutate()}
              loading={refreshMutation.isPending}
            >
              {t('common.refresh')}
            </Button>
          </>
        }
      />

      {!selectedProject && (
        <EmptyState
          icon={<TbChartLine size={48} color="var(--mantine-color-dimmed)" />}
          description={k6Installed ? t('performance.selectProject') : t('performance.toolMissing')}
        />
      )}

      {selectedProject && trends.isLoading && <StatCardsSkeleton count={5} />}

      {selectedProject && trends.isError && (
        <InlineAlert
          color="red"
          icon={<TbAlertTriangle size={14} color="var(--mantine-color-red-6)" />}
          message={t('common.loadFailed')}
          action={
            <Button size="compact-xs" variant="light" color="red" onClick={() => trends.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}

      {selectedProject && !trends.isLoading && !trends.isError && runs.length === 0 && (
        <EmptyState
          icon={<TbChartLine size={48} color="var(--mantine-color-dimmed)" />}
          description={t('performance.noData')}
        />
      )}

      {runs.length > 0 && (
        <Stack gap="md">
          {/* Summary cards — latest run */}
          {latest && (
            <SimpleGrid cols={{ base: 2, sm: 3, md: 5 }} spacing="xs">
              <Card withBorder p="sm">
                <Text size="xs" c="dimmed">
                  {t('perf.avgResponse')}
                </Text>
                <Text size="lg" fw={700}>
                  {latest.avg.toFixed(0)} ms
                </Text>
              </Card>
              <Card withBorder p="sm">
                <Text size="xs" c="dimmed">
                  P95
                </Text>
                <Text size="lg" fw={700}>
                  {latest.p95.toFixed(0)} ms
                </Text>
              </Card>
              <Card withBorder p="sm">
                <Text size="xs" c="dimmed">
                  P99
                </Text>
                <Text size="lg" fw={700}>
                  {latest.p99.toFixed(0)} ms
                </Text>
              </Card>
              <Card withBorder p="sm">
                <Text size="xs" c="dimmed">
                  RPS
                </Text>
                <Text size="lg" fw={700}>
                  {latest.rps.toFixed(1)}
                </Text>
              </Card>
              <Card withBorder p="sm">
                <Text size="xs" c="dimmed">
                  {t('perf.errorRate')}
                </Text>
                <Text size="lg" fw={700} c={latest.errorRate > 1 ? 'red' : 'green'}>
                  {latest.errorRate.toFixed(2)}%
                </Text>
              </Card>
            </SimpleGrid>
          )}

          {/* Run history */}
          <Paper withBorder p="md">
            <Text size="sm" fw={600} mb="sm">
              {t('perf.runHistory')} ({runs.length})
            </Text>
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('perf.run')}</Table.Th>
                  <Table.Th>{t('perf.avgMs')}</Table.Th>
                  <Table.Th>P95 (ms)</Table.Th>
                  <Table.Th>P99 (ms)</Table.Th>
                  <Table.Th>RPS</Table.Th>
                  <Table.Th>{t('perf.errorPct')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {runs.slice(0, 20).map((run) => {
                  const p = runPoint(run);
                  return (
                    <Table.Tr key={run.runId}>
                      <Table.Td>
                        <Text size="xs" ff="monospace">
                          {run.runId.slice(0, 24)}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs">{p.avg.toFixed(0)}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs">{p.p95.toFixed(0)}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs">{p.p99.toFixed(0)}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs">{p.rps.toFixed(1)}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c={p.errorRate > 1 ? 'red' : 'green'}>
                          {p.errorRate.toFixed(2)}%
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Paper>

          {/* Thresholds — latest run */}
          {latestThresholds.length > 0 && (
            <Paper withBorder p="md">
              <Text size="sm" fw={600} mb="sm">
                {t('perf.thresholds')}
              </Text>
              <Table striped highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('perf.metric')}</Table.Th>
                    <Table.Th>{t('table.status')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {latestThresholds.map((th) => (
                    <Table.Tr key={th.name}>
                      <Table.Td>
                        <Text size="xs" ff="monospace">
                          {th.name}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          size="sm"
                          color={th.passed ? 'green' : 'red'}
                          variant="light"
                          leftSection={th.passed ? <TbCheck size={10} /> : <TbX size={10} />}
                        >
                          {th.passed ? 'Pass' : 'Fail'}
                        </Badge>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Paper>
          )}
        </Stack>
      )}
    </Stack>
  );
}
