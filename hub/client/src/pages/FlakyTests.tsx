import type { TestStatus, TestTrend, TestTrendReport } from '@hub/shared';
import {
  Badge,
  Collapse,
  Group,
  Paper,
  Progress,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { TbChevronRight, TbFlame, TbSearch } from 'react-icons/tb';
import { qAllTestTrends } from '~/api/queries.js';
import { EmptyState } from '~/components/EmptyState.js';
import { PageHeader } from '~/components/PageHeader.js';
import { ListSkeleton } from '~/components/Skeletons.js';
import { useTools } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';
import { toolLabel } from '~/utils/tool-label.js';

function statusColor(status: TestStatus): string {
  return status === 'passed' ? 'green' : 'red';
}

/** A left-to-right dot timeline of a test's recent outcomes (newest last). */
function TrendDots({ points }: { points: TestTrend['points'] }) {
  const shown = points.slice(-12);
  return (
    <Group gap={3} wrap="nowrap">
      {shown.map((p) => (
        <Tooltip key={p.runId} label={`${p.status} · ${dayjs(p.at).format('DD MMM HH:mm')}`}>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: `var(--mantine-color-${statusColor(p.status)}-6)`,
            }}
          />
        </Tooltip>
      ))}
    </Group>
  );
}

/** `query` must already be trimmed + lowercased; empty matches everything. */
function reportMatches(r: TestTrendReport, query: string): boolean {
  if (!query) return true;
  if (
    r.project.toLowerCase().includes(query) ||
    r.type.toLowerCase().includes(query) ||
    r.tool.toLowerCase().includes(query)
  ) {
    return true;
  }
  return r.tests.some(
    (test) =>
      test.title.toLowerCase().includes(query) ||
      (test.caseId?.toLowerCase().includes(query) ?? false),
  );
}

export function FlakyTestsPage() {
  const t = useT();
  const tools = useTools().data ?? [];
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const allQ = useQuery(qAllTestTrends());
  const reports = allQ.data ?? [];
  const query = q.trim().toLowerCase();

  const { visible, flakyTotal } = useMemo(() => {
    const matched = reports.filter((r) => reportMatches(r, query));
    const sorted = [...matched].sort(
      (a, b) =>
        b.flakyCount - a.flakyCount ||
        toolLabel(a.tool, tools).localeCompare(toolLabel(b.tool, tools)) ||
        a.type.localeCompare(b.type) ||
        a.project.localeCompare(b.project),
    );
    return { visible: sorted, flakyTotal: reports.reduce((n, r) => n + r.flakyCount, 0) };
  }, [reports, query, tools]);

  const searching = query.length > 0;
  const isCollapsed = (key: string) => !searching && collapsed.has(key);
  const groupKey = (r: TestTrendReport) => `${r.tool}|${r.type}|${r.project}`;
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
      <PageHeader
        title={t('nav.flakyTests')}
        description={t('flaky.desc')}
        actions={
          reports.length > 0 ? (
            <Badge size="sm" variant="light" color={flakyTotal > 0 ? 'orange' : 'gray'}>
              {flakyTotal} {t('flaky.flakyBadge')}
            </Badge>
          ) : undefined
        }
      />

      {allQ.isLoading ? (
        <ListSkeleton rows={4} />
      ) : reports.length === 0 ? (
        <EmptyState
          icon={<TbFlame size={48} color="var(--mantine-color-dimmed)" />}
          title={t('flaky.empty')}
          description={t('flaky.unavailable')}
        />
      ) : (
        <>
          <TextInput
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            placeholder={t('flaky.searchPlaceholder')}
            leftSection={<TbSearch size={14} />}
          />
          {visible.length === 0 ? (
            <Text size="sm" c="dimmed" ta="center" py="lg">
              {t('flaky.noMatch')}
            </Text>
          ) : (
            <Stack gap="xs">
              {visible.map((r) => {
                const key = groupKey(r);
                return (
                  <Paper key={key} withBorder p="xs">
                    <UnstyledButton
                      onClick={() => toggle(key)}
                      aria-expanded={!isCollapsed(key)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        width: '100%',
                        minWidth: 0,
                      }}
                    >
                      <TbChevronRight
                        size={15}
                        style={{
                          transform: isCollapsed(key) ? 'none' : 'rotate(90deg)',
                          transition: 'transform 150ms ease',
                          opacity: 0.6,
                          flexShrink: 0,
                        }}
                      />
                      <Badge size="sm" variant="light" color="gray" style={{ flexShrink: 0 }}>
                        {toolLabel(r.tool, tools)}
                      </Badge>
                      <Text size="sm" fw={500} truncate style={{ flex: 1, textAlign: 'left' }}>
                        {r.type} · {r.project}
                      </Text>
                      {r.flakyCount > 0 && (
                        <Badge size="xs" variant="light" color="orange" style={{ flexShrink: 0 }}>
                          {r.flakyCount} {t('flaky.flakyBadge')}
                        </Badge>
                      )}
                      <Badge
                        size="xs"
                        variant="light"
                        color="gray"
                        circle
                        style={{ flexShrink: 0 }}
                      >
                        {r.totalTests}
                      </Badge>
                    </UnstyledButton>
                    <Collapse expanded={!isCollapsed(key)}>
                      <Table striped mt="xs">
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>{t('flaky.testId')}</Table.Th>
                            <Table.Th>{t('flaky.flakiness')}</Table.Th>
                            <Table.Th>{t('flaky.passRate')}</Table.Th>
                            <Table.Th>{t('flaky.passFail')}</Table.Th>
                            <Table.Th>{t('flaky.recent')}</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {r.tests.map((row) => (
                            <Table.Tr key={row.key}>
                              <Table.Td>
                                <Group gap={6} wrap="nowrap">
                                  {row.isFlaky && (
                                    <Badge size="xs" variant="light" color="orange">
                                      {t('flaky.flakyBadge')}
                                    </Badge>
                                  )}
                                  <Tooltip label={row.title} withArrow openDelay={400} multiline>
                                    <Text size="xs" ff="monospace" lineClamp={1} maw={260}>
                                      {row.caseId ?? row.title}
                                    </Text>
                                  </Tooltip>
                                </Group>
                              </Table.Td>
                              <Table.Td w={140}>
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
                                <Text
                                  size="xs"
                                  fw={500}
                                  c={row.passRate >= 80 ? 'green' : 'orange'}
                                >
                                  {row.passRate}%
                                </Text>
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
                                <TrendDots points={row.points} />
                              </Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    </Collapse>
                  </Paper>
                );
              })}
            </Stack>
          )}
        </>
      )}
    </Stack>
  );
}
