import { COVERAGE_UNMAPPED, type CoverageOutcome, type CoverageReport } from '@hub/shared';
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
  UnstyledButton,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { TbChevronRight, TbListCheck, TbSearch } from 'react-icons/tb';
import { qAllCoverage } from '~/api/queries.js';
import { EmptyState } from '~/components/EmptyState.js';
import { PageHeader } from '~/components/PageHeader.js';
import { ListSkeleton } from '~/components/Skeletons.js';
import { useTools } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';
import { toolLabel } from '~/utils/tool-label.js';

function outcomeColor(o: CoverageOutcome): string {
  return o === 'passed' ? 'green' : o === 'failed' ? 'red' : 'gray';
}

function reportMatches(r: CoverageReport, query: string): boolean {
  if (!query) return true;
  if (
    r.project.toLowerCase().includes(query) ||
    r.type.toLowerCase().includes(query) ||
    r.tool.toLowerCase().includes(query)
  ) {
    return true;
  }
  return r.groups.some((g) =>
    g.cases.some(
      (c) =>
        c.caseId.toLowerCase().includes(query) ||
        c.scenario.toLowerCase().includes(query) ||
        c.requirementRef.toLowerCase().includes(query),
    ),
  );
}

export function CoveragePage() {
  const t = useT();
  const tools = useTools().data ?? [];
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const allQ = useQuery(qAllCoverage());
  const reports = allQ.data ?? [];
  const query = q.trim().toLowerCase();

  const visible = useMemo(() => {
    const matched = reports.filter((r) => reportMatches(r, query));
    return [...matched].sort(
      (a, b) =>
        toolLabel(a.tool, tools).localeCompare(toolLabel(b.tool, tools)) ||
        a.type.localeCompare(b.type) ||
        a.project.localeCompare(b.project),
    );
  }, [reports, query, tools]);

  const searching = query.length > 0;
  const isCollapsed = (key: string) => !searching && collapsed.has(key);
  const groupKey = (r: CoverageReport) => `${r.tool}|${r.type}|${r.project}`;
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
      <PageHeader title={t('nav.coverage')} description={t('coverage.desc')} />

      {allQ.isLoading ? (
        <ListSkeleton rows={4} />
      ) : reports.length === 0 ? (
        <EmptyState
          icon={<TbListCheck size={48} color="var(--mantine-color-dimmed)" />}
          description={t('coverage.empty')}
        />
      ) : (
        <>
          <TextInput
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            placeholder={t('coverage.searchPlaceholder')}
            leftSection={<TbSearch size={14} />}
          />
          {visible.length === 0 ? (
            <Text size="sm" c="dimmed" ta="center" py="lg">
              {t('coverage.noMatch')}
            </Text>
          ) : (
            <Stack gap="xs">
              {visible.map((r) => {
                const key = groupKey(r);
                const coveredPct =
                  r.totalCases > 0 ? Math.round((r.covered / r.totalCases) * 100) : 0;
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
                      <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                        {r.covered}/{r.totalCases} ({coveredPct}%)
                      </Text>
                      <Progress
                        value={coveredPct}
                        size="sm"
                        w={80}
                        color={coveredPct >= 80 ? 'green' : 'orange'}
                        style={{ flexShrink: 0 }}
                      />
                    </UnstyledButton>
                    <Collapse expanded={!isCollapsed(key)}>
                      <Stack gap="xs" mt="xs">
                        {r.groups.map((g) => {
                          const label =
                            g.requirement === COVERAGE_UNMAPPED
                              ? t('coverage.unmapped')
                              : g.requirement;
                          return (
                            <div key={`${key}/${g.requirement}`}>
                              <Group gap={8} wrap="nowrap" mb={4} px={4}>
                                <Badge
                                  size="xs"
                                  variant="light"
                                  color={g.requirement === COVERAGE_UNMAPPED ? 'gray' : 'blue'}
                                >
                                  {label}
                                </Badge>
                                <Text size="xs" c="dimmed">
                                  {g.passed}/{g.total} {t('coverage.passed')}
                                </Text>
                              </Group>
                              <Table>
                                <Table.Tbody>
                                  {g.cases.map((c) => (
                                    <Table.Tr key={`${g.requirement}/${c.doc}/${c.caseId}`}>
                                      <Table.Td w={160}>
                                        <Text size="xs" ff="monospace" lineClamp={1}>
                                          {c.caseId}
                                        </Text>
                                      </Table.Td>
                                      <Table.Td>
                                        <Text size="xs" c="dimmed" lineClamp={1}>
                                          {c.scenario}
                                        </Text>
                                      </Table.Td>
                                      <Table.Td w={90}>
                                        <Badge
                                          size="xs"
                                          variant="light"
                                          color={outcomeColor(c.outcome)}
                                        >
                                          {t(`coverage.outcome.${c.outcome}`)}
                                        </Badge>
                                      </Table.Td>
                                    </Table.Tr>
                                  ))}
                                </Table.Tbody>
                              </Table>
                            </div>
                          );
                        })}
                      </Stack>
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
