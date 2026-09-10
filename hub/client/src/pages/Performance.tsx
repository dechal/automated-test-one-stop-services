import type { K6RunSummary, K6TrendData } from '@hub/shared';
import {
  Badge,
  Button,
  Card,
  Collapse,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import {
  TbChartLine,
  TbCheck,
  TbChevronRight,
  TbInfoCircle,
  TbRefresh,
  TbSearch,
  TbX,
} from 'react-icons/tb';
import { api } from '~/api/client';
import { EmptyState } from '~/components/EmptyState.js';
import { K6TrendChart } from '~/components/K6TrendChart.js';
import { ListSkeleton } from '~/components/Skeletons.js';
import { toast } from '~/components/Toast';
import { useTools } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';

/**
 * A k6 run's metrics are a time-series; the stored summary writes a single
 * end-of-test point. Reduce a run to that representative point for the cards +
 * trend table.
 */
function runPoint(run: K6RunSummary) {
  const m = run.metrics[run.metrics.length - 1];
  return {
    avg: m?.avgResponseTime ?? 0,
    med: m?.medResponseTime ?? 0,
    p90: m?.p90ResponseTime ?? 0,
    p95: m?.p95ResponseTime ?? 0,
    p99: m?.p99ResponseTime ?? 0,
    min: m?.minResponseTime ?? 0,
    max: m?.maxResponseTime ?? 0,
    rps: m?.rps ?? 0,
    errorRate: m?.errorRate ?? 0,
    totalRequests: m?.totalRequests ?? 0,
    failedRequests: m?.failedRequests ?? 0,
    dataSent: m?.dataSent ?? 0,
    dataReceived: m?.dataReceived ?? 0,
    waiting: m?.waitingTime ?? 0,
    connecting: m?.connectingTime ?? 0,
    blocked: m?.blockedTime ?? 0,
    iterations: m?.iterations ?? 0,
    checksPassed: m?.checksPassed ?? 0,
    checksFailed: m?.checksFailed ?? 0,
    checkRate: m?.checkRate ?? 0,
    vus: m?.vus ?? 0,
  };
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function PerformancePage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toolsQuery = useTools();
  const k6Installed = (toolsQuery.data ?? []).some(
    (tv) => tv.id === 'k6' && tv.status === 'enabled',
  );

  const allQ = useQuery<K6TrendData[]>({
    queryKey: ['k6-trends'],
    queryFn: () => api.get('/api/k6-trends'),
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.post('/api/k6-trends/refresh'),
    onSuccess: () => {
      toast.success(t('performance.refreshed'));
      queryClient.invalidateQueries({ queryKey: ['k6-trends'] });
    },
    onError: () => toast.error(t('performance.refreshFailed')),
  });

  // Only projects that actually have runs; a project with none adds no card.
  const withRuns = (allQ.data ?? []).filter((d) => d.runs.length > 0);
  const query = q.trim().toLowerCase();
  const visible = useMemo(
    () =>
      withRuns
        .filter((d) => !query || d.project.toLowerCase().includes(query))
        .sort((a, b) => a.project.localeCompare(b.project)),
    [withRuns, query],
  );

  const searching = query.length > 0;
  const isCollapsed = (key: string) => !searching && collapsed.has(key);
  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <Stack gap="md">
      <PageHeaderRow
        onRefresh={() => refreshMutation.mutate()}
        refreshing={refreshMutation.isPending}
      />

      {allQ.isLoading ? (
        <ListSkeleton rows={4} />
      ) : !k6Installed ? (
        <EmptyState
          icon={<TbChartLine size={48} color="var(--mantine-color-dimmed)" />}
          description={t('performance.toolMissing')}
        />
      ) : withRuns.length === 0 ? (
        <EmptyState
          icon={<TbChartLine size={48} color="var(--mantine-color-dimmed)" />}
          description={t('performance.noData')}
        />
      ) : (
        <>
          <TextInput
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            placeholder={t('performance.searchPlaceholder')}
            leftSection={<TbSearch size={14} />}
          />
          {visible.length === 0 ? (
            <Text size="sm" c="dimmed" ta="center" py="lg">
              {t('performance.noMatch')}
            </Text>
          ) : (
            <Stack gap="xs">
              {visible.map((d) => (
                <ProjectTrendCard
                  key={d.project}
                  data={d}
                  open={!isCollapsed(d.project)}
                  onToggle={() => toggle(d.project)}
                />
              ))}
            </Stack>
          )}
        </>
      )}
    </Stack>
  );
}

function PageHeaderRow({ onRefresh, refreshing }: { onRefresh: () => void; refreshing: boolean }) {
  const t = useT();
  return (
    <Group justify="space-between" align="flex-start">
      <div>
        <Text fw={600} fz="h4">
          {t('nav.performance')}
        </Text>
        <Text size="sm" c="dimmed">
          {t('performance.desc')}
        </Text>
      </div>
      <Button
        leftSection={<TbRefresh size={14} />}
        size="xs"
        variant="light"
        onClick={onRefresh}
        loading={refreshing}
      >
        {t('common.refresh')}
      </Button>
    </Group>
  );
}

function ProjectTrendCard({
  data,
  open,
  onToggle,
}: {
  data: K6TrendData;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const runs = data.runs;
  const latest = runs[0] ? runPoint(runs[0]) : undefined;
  const latestThresholds = runs[0]?.thresholds ?? [];

  return (
    <Paper withBorder p="xs">
      <UnstyledButton
        onClick={onToggle}
        aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minWidth: 0 }}
      >
        <TbChevronRight
          size={15}
          style={{
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform 150ms ease',
            opacity: 0.6,
            flexShrink: 0,
          }}
        />
        <Text size="sm" fw={500} truncate style={{ flex: 1, textAlign: 'left' }}>
          {data.project}
        </Text>
        {latest && (
          <Text size="xs" c={latest.errorRate > 1 ? 'red' : 'dimmed'} style={{ flexShrink: 0 }}>
            P95 {latest.p95.toFixed(0)}ms · {latest.errorRate.toFixed(2)}%
          </Text>
        )}
        <Badge size="xs" variant="light" color="gray" circle style={{ flexShrink: 0 }}>
          {runs.length}
        </Badge>
      </UnstyledButton>
      <Collapse expanded={open}>
        <Stack gap="md" mt="xs">
          {latest && (
            <Stack gap="sm">
              <MetricSection title={t('perf.groupResponse')}>
                <MetricCard
                  label={t('perf.avgResponse')}
                  value={`${latest.avg.toFixed(0)} ms`}
                  help={t('perf.help.avg')}
                />
                <MetricCard
                  label={t('perf.median')}
                  value={`${latest.med.toFixed(0)} ms`}
                  help={t('perf.help.med')}
                />
                <MetricCard
                  label="P90"
                  value={`${latest.p90.toFixed(0)} ms`}
                  help={t('perf.help.p90')}
                />
                <MetricCard
                  label="P95"
                  value={`${latest.p95.toFixed(0)} ms`}
                  help={t('perf.help.p95')}
                />
                <MetricCard
                  label="P99"
                  value={`${latest.p99.toFixed(0)} ms`}
                  help={t('perf.help.p99')}
                />
                <MetricCard
                  label={t('perf.min')}
                  value={`${latest.min.toFixed(0)} ms`}
                  help={t('perf.help.min')}
                />
                <MetricCard
                  label={t('perf.max')}
                  value={`${latest.max.toFixed(0)} ms`}
                  help={t('perf.help.max')}
                />
              </MetricSection>

              <MetricSection title={t('perf.groupThroughput')}>
                <MetricCard label="RPS" value={latest.rps.toFixed(1)} help={t('perf.help.rps')} />
                <MetricCard
                  label={t('perf.totalRequests')}
                  value={latest.totalRequests.toLocaleString()}
                  help={t('perf.help.totalRequests')}
                />
                <MetricCard
                  label={t('perf.iterations')}
                  value={latest.iterations.toLocaleString()}
                  help={t('perf.help.iterations')}
                />
                <MetricCard label="VUs" value={String(latest.vus)} help={t('perf.help.vus')} />
                <MetricCard
                  label={t('perf.dataReceived')}
                  value={formatBytes(latest.dataReceived)}
                  help={t('perf.help.dataReceived')}
                />
                <MetricCard
                  label={t('perf.dataSent')}
                  value={formatBytes(latest.dataSent)}
                  help={t('perf.help.dataSent')}
                />
              </MetricSection>

              <MetricSection title={t('perf.groupReliability')}>
                <MetricCard
                  label={t('perf.errorRate')}
                  value={`${latest.errorRate.toFixed(2)}%`}
                  help={t('perf.help.errorRate')}
                  danger={latest.errorRate > 1}
                />
                <MetricCard
                  label={t('perf.failedRequests')}
                  value={latest.failedRequests.toLocaleString()}
                  help={t('perf.help.failedRequests')}
                  danger={latest.failedRequests > 0}
                />
                <MetricCard
                  label={t('perf.checkRate')}
                  value={`${(latest.checkRate * 100).toFixed(1)}%`}
                  help={t('perf.help.checkRate')}
                  danger={latest.checkRate < 1 && latest.checksFailed > 0}
                />
                <MetricCard
                  label={t('perf.checksFailed')}
                  value={latest.checksFailed.toLocaleString()}
                  help={t('perf.help.checksFailed')}
                  danger={latest.checksFailed > 0}
                />
              </MetricSection>

              <MetricSection title={t('perf.groupTiming')}>
                <MetricCard
                  label={t('perf.waiting')}
                  value={`${latest.waiting.toFixed(0)} ms`}
                  help={t('perf.help.waiting')}
                />
                <MetricCard
                  label={t('perf.connecting')}
                  value={`${latest.connecting.toFixed(0)} ms`}
                  help={t('perf.help.connecting')}
                />
                <MetricCard
                  label={t('perf.blocked')}
                  value={`${latest.blocked.toFixed(0)} ms`}
                  help={t('perf.help.blocked')}
                />
              </MetricSection>
            </Stack>
          )}

          <div>
            <Text size="sm" fw={600} mb="sm">
              {t('perf.trends')}
            </Text>
            <K6TrendChart runs={runs} />
          </div>

          <div>
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
          </div>

          {latestThresholds.length > 0 && (
            <div>
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
            </div>
          )}
        </Stack>
      </Collapse>
    </Paper>
  );
}

function MetricSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <Text size="xs" fw={600} c="dimmed" tt="uppercase" mb={6}>
        {title}
      </Text>
      <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }} spacing="xs">
        {children}
      </SimpleGrid>
    </div>
  );
}

function MetricCard({
  label,
  value,
  help,
  danger,
}: {
  label: string;
  value: string;
  help?: string;
  danger?: boolean;
}) {
  return (
    <Card withBorder p="sm">
      <Group gap={4} wrap="nowrap">
        <Text size="xs" c="dimmed" truncate>
          {label}
        </Text>
        {help && (
          <Tooltip label={help} withArrow multiline w={240} openDelay={200}>
            <span style={{ display: 'inline-flex', cursor: 'help', opacity: 0.5 }}>
              <TbInfoCircle size={12} />
            </span>
          </Tooltip>
        )}
      </Group>
      <Text size="lg" fw={700} c={danger ? 'red' : undefined}>
        {value}
      </Text>
    </Card>
  );
}
