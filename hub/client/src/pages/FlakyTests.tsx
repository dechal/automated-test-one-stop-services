import type { FlakyReport, FlakyTestEntry, RunStatus } from '@hub/shared';
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Paper,
  Progress,
  Select,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { TbAlertTriangle, TbAnalyze, TbFlame, TbX } from 'react-icons/tb';
import { api } from '~/api/client';
import { EmptyState } from '~/components/EmptyState.js';
import { InlineAlert } from '~/components/InlineAlert.js';
import { PageHeader } from '~/components/PageHeader.js';
import { ListSkeleton } from '~/components/Skeletons.js';
import { toast } from '~/components/Toast';
import { useAllProjects } from '~/hooks/useProjectQueries';
import { useT } from '~/i18n/index.js';

function statusColor(status: RunStatus): string {
  switch (status) {
    case 'passed':
      return 'green';
    case 'failed':
      return 'red';
    case 'skipped':
      return 'gray';
    default:
      return 'blue';
  }
}

/** Server stores tests keyed by `${tool}/${type}/${project}/${testId}`. */
function buildTestKey(t: FlakyTestEntry): string {
  return `${t.tool}/${t.type}/${t.project}/${t.testId}`;
}

export function FlakyTestsPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [projectFilter, setProjectFilter] = useState<string | null>(null);

  const flaky = useQuery<FlakyReport>({
    queryKey: ['flaky'],
    queryFn: () => api.get('/api/flaky'),
  });

  const projects = useAllProjects();

  const tests = useMemo<FlakyTestEntry[]>(() => {
    const list = flaky.data?.flakyTests ?? [];
    return projectFilter ? list.filter((t) => t.project === projectFilter) : list;
  }, [flaky.data, projectFilter]);

  const analyzeMutation = useMutation({
    // `POST /api/flaky/analyze` runs the detection inline and returns the finished
    // report, so this resolves only once the work is done. The old toast said
    // "started", which left no way to tell whether anything had happened —
    // report the outcome and how many entries it found instead.
    mutationFn: () => api.post<{ flakyTests: FlakyTestEntry[] }>('/api/flaky/analyze'),
    onSuccess: (data) => {
      toast.success(`${t('flaky.analysisDone')} (${data?.flakyTests?.length ?? 0})`);
      queryClient.invalidateQueries({ queryKey: ['flaky'] });
    },
    onError: () => toast.error(t('flaky.analysisFailed')),
  });

  const dismissMutation = useMutation({
    mutationFn: (testKey: string) => api.post('/api/flaky/dismiss', { testKey }),
    onSuccess: () => {
      toast.success(t('flaky.dismissed'));
      queryClient.invalidateQueries({ queryKey: ['flaky'] });
    },
    onError: () => toast.error(t('flaky.dismissFailed')),
  });

  return (
    <Stack gap="md">
      <PageHeader
        title={t('nav.flakyTests')}
        actions={
          <>
            <Select
              size="xs"
              placeholder={t('filter.allProjects')}
              value={projectFilter}
              onChange={setProjectFilter}
              data={projects.data ?? []}
              clearable
              searchable
              w={180}
            />
            <Button
              leftSection={<TbAnalyze size={14} />}
              size="xs"
              onClick={() => analyzeMutation.mutate()}
              loading={analyzeMutation.isPending}
            >
              {t('flaky.analyze')}
            </Button>
          </>
        }
      />

      {flaky.isLoading && <ListSkeleton rows={4} />}

      {flaky.isError && (
        <InlineAlert
          color="red"
          icon={<TbAlertTriangle size={14} color="var(--mantine-color-red-6)" />}
          message={t('common.loadFailed')}
          action={
            <Button size="compact-xs" variant="light" color="red" onClick={() => flaky.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}

      {flaky.data && tests.length === 0 && (
        <EmptyState
          icon={<TbFlame size={48} color="var(--mantine-color-dimmed)" />}
          description={
            <Stack align="center" gap="sm">
              <Text size="sm" c="dimmed">
                {projectFilter
                  ? `${t('flaky.emptyForProject')} (${projectFilter})`
                  : t('flaky.empty')}
              </Text>
              {(flaky.data.totalTests ?? 0) > 0 && (
                <Text size="xs" c="dimmed">
                  Last analyzed {dayjs(flaky.data.generatedAt).format('DD MMM HH:mm')} ·{' '}
                  {flaky.data.totalTests} tracked
                </Text>
              )}
            </Stack>
          }
        />
      )}

      {tests.length > 0 && (
        <Paper withBorder>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('flaky.testId')}</Table.Th>
                <Table.Th>{t('run.project')}</Table.Th>
                <Table.Th>{t('run.tool')}</Table.Th>
                <Table.Th>{t('flaky.flakiness')}</Table.Th>
                <Table.Th>{t('flaky.passFail')}</Table.Th>
                <Table.Th>{t('flaky.recent')}</Table.Th>
                <Table.Th>{t('flaky.lastSeen')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {tests.map((row) => {
                const key = buildTestKey(row);
                return (
                  <Table.Tr key={key}>
                    <Table.Td>
                      <Text size="xs" ff="monospace" lineClamp={1} maw={200}>
                        {row.testId}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge size="xs" variant="light">
                        {row.project}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">{row.tool}</Text>
                    </Table.Td>
                    <Table.Td w={120}>
                      <Group gap={4} wrap="nowrap">
                        <Progress
                          value={row.flakinessScore}
                          size="sm"
                          color={row.flakinessScore > 50 ? 'red' : 'orange'}
                          style={{ flex: 1 }}
                        />
                        <Text size="xs" fw={500} w={32} ta="right">
                          {row.flakinessScore}%
                        </Text>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">
                        <Text span c="green" fw={500}>
                          {row.passes}
                        </Text>
                        {' / '}
                        <Text span c="red" fw={500}>
                          {row.failures}
                        </Text>
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={2}>
                        {row.recentStatuses.map((s, i) => (
                          <Tooltip key={i as number} label={s}>
                            <div
                              style={{
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                backgroundColor: `var(--mantine-color-${statusColor(s)}-6)`,
                              }}
                            />
                          </Tooltip>
                        ))}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {dayjs(row.lastSeen).format('DD MMM HH:mm')}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Tooltip label={t('flaky.dismiss')}>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          size="sm"
                          onClick={() => dismissMutation.mutate(key)}
                          aria-label={t('flaky.dismissAria')}
                        >
                          <TbX size={14} />
                        </ActionIcon>
                      </Tooltip>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Paper>
      )}
    </Stack>
  );
}
