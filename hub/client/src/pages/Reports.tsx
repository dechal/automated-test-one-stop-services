import type { ReportEntry, RunSummary, ToolId } from '@hub/shared';
import { parseTagExpr } from '@hub/shared';
import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Group,
  Pagination,
  Paper,
  ScrollArea,
  Select,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { DatePickerInput, type DateValue } from '@mantine/dates';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import {
  TbCalendar,
  TbExternalLink,
  TbFilter,
  TbLock,
  TbLockOpen,
  TbPlayerPlay,
  TbReportAnalytics,
  TbStar,
  TbStarFilled,
  TbTrash,
} from 'react-icons/tb';
import { api } from '~/api/client.js';
import { confirmDialog } from '~/components/confirmDialog.js';
import { EmptyState } from '~/components/EmptyState.js';
import { ErrorState } from '~/components/ErrorState.js';
import { PageHeader } from '~/components/PageHeader.js';
import { PassScoreCell } from '~/components/PassScoreCell.js';
import { ArtifactMenu } from '~/components/reports/ArtifactMenu.js';
import { SavedFiltersBar } from '~/components/SavedFilters.js';
import { toast } from '~/components/Toast.js';
import { PAGE_SIZE_OPTIONS, SortableHeader } from '~/components/table/SortableHeader.js';
import { useTableSort } from '~/hooks/useTableSort.js';
import { useTools } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';
import { usePreferences } from '~/stores/hub.js';
import { formatAbsolute, formatDurationMs, formatRelative } from '~/utils/datetime.js';
import { getStatusColor, getStatusIcon } from '~/utils/run-status.js';

const ALL_STATUSES = ['success', 'error'];

// The server emits report timestamps as ISO-8601 strings (same shape as a
// run's `startedAt`), so they parse with a plain `dayjs(iso)` — no month-name
// custom format, and they sort chronologically as strings.

type SortField = 'timestamp' | 'tool' | 'project' | 'type' | 'status';

/**
 * "Cases" cell: total test-case count for a report, with a red badge when any
 * failed and a full pass/fail/skip breakdown in the tooltip. Shows a dash when
 * the report has no matching run summary (e.g. an aged-out run).
 */
function CaseCountCell({ summary }: { summary?: RunSummary }) {
  const t = useT();
  if (!summary) {
    return (
      <Text size="xs" c="dimmed">
        —
      </Text>
    );
  }
  const total = summary.passed + summary.failed + (summary.skipped ?? 0);
  const breakdown = `${summary.passed} ${t('run.passed')} · ${summary.failed} ${t('run.failed')}${
    summary.skipped ? ` · ${summary.skipped} ${t('run.skipped')}` : ''
  }`;
  return (
    <Tooltip label={breakdown} withArrow>
      <Group gap={5} wrap="nowrap">
        <Text size="xs" fw={600}>
          {total}
        </Text>
        {summary.failed > 0 && (
          <Badge size="xs" color="red" variant="light">
            {summary.failed}
          </Badge>
        )}
      </Group>
    </Tooltip>
  );
}

export function ReportsPage() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedTools, setSelectedTools] = useState<Set<ToolId>>(new Set());
  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [filterProject, setFilterProject] = useState('');
  const [dateRange, setDateRange] = useState<[DateValue, DateValue]>([null, null]);
  const [showFilters, setShowFilters] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const { sortField, sortDir, handleSort } = useTableSort<SortField>('timestamp');
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  // Tool and Mode are engineering metadata: shown only in advanced mode. Sort
  // state is untouched when a hidden column is the active sort field.
  const advancedMode = usePreferences((s) => s.advancedMode);

  const reports = useQuery<ReportEntry[]>({
    queryKey: ['reports'],
    queryFn: () => api.get('/api/reports'),
  });

  const toolIds = (useTools().data ?? [])
    .filter((t) => t.status === 'enabled')
    .map((t) => t.id as ToolId);

  const deleteMutation = useMutation({
    mutationFn: (reportPath: string) =>
      api.delete(`/api/reports?path=${encodeURIComponent(reportPath)}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['reports'] });
      toast.success(t('reports.reportDeleted'));
    },
    onError: () => toast.error(t('reports.deleteFailed')),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (paths: string[]) => {
      for (const p of paths) {
        await api.delete(`/api/reports?path=${encodeURIComponent(p)}`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['reports'] });
      setSelectedRows(new Set());
      toast.success(t('reports.reportsDeleted'));
    },
    onError: () => toast.error(t('reports.deleteSomeFailed')),
  });

  const lockMutation = useMutation({
    mutationFn: (reportPath: string) => api.post('/api/reports/lock', { path: reportPath }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['reports'] });
      toast.success(t('reports.locked'));
    },
    onError: () => toast.error(t('reports.lockFailed')),
  });

  const unlockMutation = useMutation({
    mutationFn: (reportPath: string) => api.post('/api/reports/unlock', { path: reportPath }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['reports'] });
      toast.success(t('reports.unlocked'));
    },
    onError: () => toast.error(t('reports.unlockFailed')),
  });

  const favoriteMutation = useMutation({
    mutationFn: ({ path, on }: { path: string; on: boolean }) =>
      api.post(`/api/reports/${on ? 'favorite' : 'unfavorite'}`, { path }),
    onSuccess: (_res, { on }) => {
      queryClient.invalidateQueries({ queryKey: ['reports'] });
      toast.success(on ? t('reports.favorited') : t('reports.unfavorited'));
    },
    onError: () => toast.error(t('reports.lockFailed')),
  });

  async function handleDelete(reportPath: string) {
    const ok = await confirmDialog({
      title: t('reports.deleteTitle'),
      message: t('reports.cannotUndo'),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (ok) {
      deleteMutation.mutate(reportPath);
    }
  }

  async function handleBulkDelete() {
    // Favourites are filtered again here, not just in the checkbox: a selection
    // made before a row was favourited is still in state.
    const favorites = new Set(
      (reports.data ?? []).filter((r) => r.favorite).map((r) => r.reportPath),
    );
    const paths = [...selectedRows].filter((p) => !favorites.has(p));
    if (paths.length === 0) return;
    const ok = await confirmDialog({
      title: `${t('common.delete')} ${paths.length} ${t('reports.reportsWord')}?`,
      message: t('reports.cannotUndo'),
      confirmLabel: `${t('common.delete')} ${paths.length}`,
      danger: true,
    });
    if (ok) {
      bulkDeleteMutation.mutate(paths);
    }
  }

  const availableTypes = [...new Set((reports.data ?? []).map((r) => r.type))].sort();

  function toggleInSet<T>(set: Set<T>, value: T): Set<T> {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  }

  function toggleRow(reportPath: string) {
    setSelectedRows((prev) => toggleInSet(prev, reportPath));
  }

  function toggleAllRows(paths: string[]) {
    const allSelected = paths.every((p) => selectedRows.has(p));
    if (allSelected) {
      setSelectedRows(new Set());
    } else {
      setSelectedRows(new Set(paths));
    }
  }

  const filtered = useMemo(
    () =>
      (reports.data ?? []).filter((r) => {
        if (selectedTools.size > 0 && !selectedTools.has(r.tool)) return false;
        if (selectedStatuses.size > 0 && !selectedStatuses.has(r.status)) return false;
        if (selectedTypes.size > 0 && !selectedTypes.has(r.type)) return false;
        if (filterProject && !r.project.toLowerCase().includes(filterProject.toLowerCase()))
          return false;
        const [from, to] = dateRange;
        if (from || to) {
          const reportDay = dayjs(r.timestamp);
          if (!reportDay.isValid()) return false;
          if (from && reportDay.isBefore(dayjs(from).startOf('day'))) return false;
          if (to && reportDay.isAfter(dayjs(to).endOf('day'))) return false;
        }
        return true;
      }),
    [reports.data, selectedTools, selectedStatuses, selectedTypes, filterProject, dateRange],
  );

  // Sort
  const sorted = useMemo(
    () =>
      [...filtered].sort((a, b) => {
        let cmp = 0;
        switch (sortField) {
          case 'timestamp':
            cmp = a.timestamp.localeCompare(b.timestamp);
            break;
          case 'tool':
            cmp = a.tool.localeCompare(b.tool);
            break;
          case 'project':
            cmp = a.project.localeCompare(b.project);
            break;
          case 'type':
            cmp = a.type.localeCompare(b.type);
            break;
          case 'status':
            cmp = a.status.localeCompare(b.status);
            break;
        }
        return sortDir === 'asc' ? cmp : -cmp;
      }),
    [filtered, sortField, sortDir],
  );

  // Pagination
  const totalPages = Math.ceil(sorted.length / pageSize);
  const safePage = Math.min(currentPage, totalPages || 1);
  const paginatedData = sorted.slice((safePage - 1) * pageSize, safePage * pageSize);
  /** Rows on this page that bulk delete is allowed to touch (favourites are not). */
  const selectablePaths = paginatedData.filter((r) => !r.favorite).map((r) => r.reportPath);

  const activeFilterCount =
    (selectedTools.size > 0 ? 1 : 0) +
    (selectedStatuses.size > 0 ? 1 : 0) +
    (selectedTypes.size > 0 ? 1 : 0) +
    (filterProject ? 1 : 0) +
    (dateRange[0] || dateRange[1] ? 1 : 0);

  function clearFilters() {
    setSelectedTools(new Set());
    setSelectedStatuses(new Set());
    setSelectedTypes(new Set());
    setFilterProject('');
    setDateRange([null, null]);
    setCurrentPage(1);
  }

  return (
    // The root is bounded and clips: the table's ScrollArea below is the only
    // scroll container on the page, so mounting the pagination bar can never
    // hand a scrollbar to the surrounding content region.
    <Stack gap="md" h="100%" style={{ minHeight: 0, overflow: 'hidden' }}>
      <div style={{ flexShrink: 0 }}>
        <PageHeader
          title={t('reports.title')}
          description={t('nav.reports.desc')}
          actions={
            <>
              {selectedRows.size > 0 && (
                <Button
                  color="red"
                  size="xs"
                  variant="light"
                  leftSection={<TbTrash size={14} />}
                  onClick={handleBulkDelete}
                  loading={bulkDeleteMutation.isPending}
                >
                  {t('common.delete')} {selectedRows.size}
                </Button>
              )}
              <Button
                variant="default"
                size="xs"
                leftSection={<TbFilter size={14} />}
                rightSection={
                  activeFilterCount > 0 ? (
                    <Badge size="xs" color="blue" circle>
                      {activeFilterCount}
                    </Badge>
                  ) : null
                }
                onClick={() => setShowFilters(!showFilters)}
              >
                {t('reports.filters')}
              </Button>
            </>
          }
        />
      </div>

      {showFilters && (
        // Bounded so a tall filter panel scrolls itself instead of squeezing
        // the table out of the clipped root.
        <Paper p="md" withBorder mah="40vh" style={{ flexShrink: 0, overflowY: 'auto' }}>
          <Stack gap="sm">
            <Group justify="space-between">
              <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                {t('reports.advancedSearch')}
              </Text>
              {activeFilterCount > 0 && (
                <Button size="compact-xs" variant="subtle" color="gray" onClick={clearFilters}>
                  {t('common.clearAll')}
                </Button>
              )}
            </Group>

            <SavedFiltersBar
              page="reports"
              currentFilters={{
                tools: [...selectedTools],
                statuses: [...selectedStatuses],
                types: [...selectedTypes],
                project: filterProject,
              }}
              onLoad={(filters) => {
                const f = filters as {
                  tools?: string[];
                  statuses?: string[];
                  types?: string[];
                  project?: string;
                };
                setSelectedTools(new Set(f.tools ?? []) as Set<ToolId>);
                setSelectedStatuses(new Set(f.statuses ?? []));
                setSelectedTypes(new Set(f.types ?? []));
                setFilterProject(f.project ?? '');
                setCurrentPage(1);
              }}
            />

            <Group grow align="flex-end">
              <DatePickerInput
                type="range"
                label={t('table.dateRange')}
                size="xs"
                value={dateRange as [DateValue, DateValue]}
                onChange={(v) => {
                  setDateRange(v);
                  setCurrentPage(1);
                }}
                placeholder={t('filter.pickDates')}
                leftSection={<TbCalendar size={14} />}
                clearable
                valueFormat="DD MMM YYYY"
              />
              <TextInput
                label={t('run.project')}
                size="xs"
                value={filterProject}
                onChange={(e) => {
                  setFilterProject(e.currentTarget.value);
                  setCurrentPage(1);
                }}
                placeholder={t('filter.filterByName')}
              />
            </Group>

            <Group gap="xl" align="flex-start" wrap="wrap">
              <Stack gap={4}>
                <Text size="xs" c="dimmed">
                  {t('filter.tools')}
                </Text>
                <Group gap={6}>
                  {toolIds.map((t) => (
                    <Badge
                      key={t}
                      size="sm"
                      variant={selectedTools.has(t) ? 'filled' : 'outline'}
                      color={selectedTools.has(t) ? 'blue' : 'gray'}
                      onClick={() => {
                        setSelectedTools(toggleInSet(selectedTools, t));
                        setCurrentPage(1);
                      }}
                      style={{ cursor: 'pointer' }}
                    >
                      {t}
                    </Badge>
                  ))}
                </Group>
              </Stack>
              {availableTypes.length > 0 && (
                <Stack gap={4}>
                  <Text size="xs" c="dimmed">
                    {t('table.type')}
                  </Text>
                  <Group gap={6}>
                    {availableTypes.map((t) => (
                      <Badge
                        key={t}
                        size="sm"
                        variant={selectedTypes.has(t) ? 'filled' : 'outline'}
                        color={selectedTypes.has(t) ? 'blue' : 'gray'}
                        onClick={() => {
                          setSelectedTypes(toggleInSet(selectedTypes, t));
                          setCurrentPage(1);
                        }}
                        style={{ cursor: 'pointer' }}
                      >
                        {t}
                      </Badge>
                    ))}
                  </Group>
                </Stack>
              )}
              <Stack gap={4}>
                <Text size="xs" c="dimmed">
                  {t('table.status')}
                </Text>
                <Group gap={6}>
                  {ALL_STATUSES.map((s) => (
                    <Badge
                      key={s}
                      size="sm"
                      variant={selectedStatuses.has(s) ? 'filled' : 'outline'}
                      color={selectedStatuses.has(s) ? getStatusColor(s) : 'gray'}
                      leftSection={getStatusIcon(s)}
                      onClick={() => {
                        setSelectedStatuses(toggleInSet(selectedStatuses, s));
                        setCurrentPage(1);
                      }}
                      style={{ cursor: 'pointer' }}
                    >
                      {s}
                    </Badge>
                  ))}
                </Group>
              </Stack>
            </Group>
          </Stack>
        </Paper>
      )}

      {reports.data && (
        <Group justify="space-between" style={{ flexShrink: 0 }}>
          <Text size="xs" c="dimmed">
            {t('filter.showing')} {paginatedData.length} {t('filter.of')} {sorted.length}{' '}
            {t('reports.reportsWord')}
            {sorted.length !== reports.data.length &&
              ` (${reports.data.length} ${t('history.totalSuffix')})`}
          </Text>
          <Group gap="xs">
            <Text size="xs" c="dimmed">
              {t('history.perPage')}:
            </Text>
            <Select
              size="xs"
              w={70}
              value={String(pageSize)}
              onChange={(v) => {
                setPageSize(Number(v));
                setCurrentPage(1);
              }}
              data={PAGE_SIZE_OPTIONS}
              allowDeselect={false}
            />
          </Group>
        </Group>
      )}

      {/* Loading skeleton */}
      {reports.isLoading && (
        <Paper withBorder p="md" style={{ flexShrink: 0 }}>
          <Stack gap="xs">
            {Array.from({ length: 8 }).map((_, i) => (
              <Group key={i as number} gap="md" wrap="nowrap">
                <Skeleton height={20} width={60} radius="sm" />
                <Skeleton height={20} width={100} radius="sm" />
                <Skeleton height={20} style={{ flex: 1 }} radius="sm" />
                <Skeleton height={20} width={60} radius="sm" />
                <Skeleton height={20} width={80} radius="sm" />
                <Skeleton height={20} width={120} radius="sm" />
              </Group>
            ))}
          </Stack>
        </Paper>
      )}

      {/* Empty state */}
      {reports.isError && (
        <div style={{ flexShrink: 0 }}>
          <ErrorState onRetry={() => reports.refetch()} />
        </div>
      )}
      {!reports.isLoading && !reports.isError && sorted.length === 0 && (
        <div style={{ flexShrink: 0 }}>
          <EmptyState
            icon={<TbReportAnalytics size={48} color="var(--mantine-color-dimmed)" />}
            description={
              activeFilterCount > 0 ? t('reports.noMatchFilter') : t('reports.noReports')
            }
            action={
              activeFilterCount > 0 ? (
                <Button size="xs" variant="subtle" onClick={clearFilters}>
                  {t('common.clearFilters')}
                </Button>
              ) : (
                <Button
                  size="xs"
                  color="green"
                  leftSection={<TbPlayerPlay size={14} />}
                  onClick={() => {
                    navigate({ to: '/run' });
                  }}
                >
                  {t('reports.runFirst')}
                </Button>
              )
            }
          />
        </div>
      )}

      {paginatedData.length > 0 && (
        <Paper
          withBorder
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Bounded ScrollArea → the table scrolls inside the card (sticky
              header) instead of growing the page. `miw` keeps a horizontal
              scroll on narrow screens. Pagination below stays pinned. */}
          <ScrollArea type="auto" style={{ flex: 1, minHeight: 0 }}>
            <Table
              striped
              highlightOnHover
              verticalSpacing="xs"
              stickyHeader
              // +60px over the previous 1100/820: lock and delete are their own
              // icons again, so the Actions column needs the room rather than
              // squeezing the Tag and Timestamp columns.
              miw={advancedMode ? 1200 : 920}
            >
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={40}>
                    {/* Select-all skips favourites — they are undeletable, so
                        including them would leave the box permanently
                        indeterminate and offer a doomed bulk delete. */}
                    <Checkbox
                      size="xs"
                      checked={
                        selectablePaths.length > 0 &&
                        selectablePaths.every((p) => selectedRows.has(p))
                      }
                      indeterminate={
                        selectablePaths.some((p) => selectedRows.has(p)) &&
                        !selectablePaths.every((p) => selectedRows.has(p))
                      }
                      onChange={() => toggleAllRows(selectablePaths)}
                      aria-label={t('reports.selectAll')}
                    />
                  </Table.Th>
                  <Table.Th>
                    <SortableHeader
                      label={t('table.status')}
                      field="status"
                      currentField={sortField}
                      currentDir={sortDir}
                      onSort={handleSort}
                    />
                  </Table.Th>
                  {advancedMode && (
                    <Table.Th>
                      <SortableHeader
                        label={t('run.tool')}
                        field="tool"
                        currentField={sortField}
                        currentDir={sortDir}
                        onSort={handleSort}
                      />
                    </Table.Th>
                  )}
                  <Table.Th>
                    <SortableHeader
                      label={t('run.project')}
                      field="project"
                      currentField={sortField}
                      currentDir={sortDir}
                      onSort={handleSort}
                    />
                  </Table.Th>
                  <Table.Th>
                    <SortableHeader
                      label={t('run.type')}
                      field="type"
                      currentField={sortField}
                      currentDir={sortDir}
                      onSort={handleSort}
                    />
                  </Table.Th>
                  <Table.Th>{t('reports.cases')}</Table.Th>
                  <Table.Th>{t('reports.passScore')}</Table.Th>
                  <Table.Th>{t('table.duration')}</Table.Th>
                  <Table.Th>{t('table.tag')}</Table.Th>
                  {advancedMode && <Table.Th>{t('table.mode')}</Table.Th>}
                  <Table.Th>
                    <SortableHeader
                      label={t('table.timestamp')}
                      field="timestamp"
                      currentField={sortField}
                      currentDir={sortDir}
                      onSort={handleSort}
                    />
                  </Table.Th>
                  <Table.Th>{t('table.actions')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {paginatedData.map((r) => (
                  <Table.Tr
                    key={r.id}
                    bg={
                      selectedRows.has(r.reportPath)
                        ? 'var(--mantine-color-brand-light)'
                        : undefined
                    }
                  >
                    <Table.Td>
                      {/* A favourite cannot be selected at all: the only thing the
                          selection drives is bulk delete, so allowing the tick
                          would offer an action that is guaranteed to be refused. */}
                      <Checkbox
                        size="xs"
                        checked={selectedRows.has(r.reportPath)}
                        disabled={r.favorite}
                        onChange={() => toggleRow(r.reportPath)}
                        aria-label={`${t('reports.selectRow')} ${r.project}`}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        color={getStatusColor(r.status)}
                        variant="light"
                        size="sm"
                        leftSection={getStatusIcon(r.status)}
                      >
                        {r.status}
                      </Badge>
                    </Table.Td>
                    {advancedMode && (
                      <Table.Td>
                        <Text size="xs" ff="monospace" truncate maw={120}>
                          {r.tool}
                        </Text>
                      </Table.Td>
                    )}
                    <Table.Td>
                      <Tooltip label={r.project} withArrow>
                        <Text size="xs" ff="monospace" truncate maw={150}>
                          {r.project}
                        </Text>
                      </Tooltip>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" truncate maw={80}>
                        {r.type}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <CaseCountCell summary={r.summary} />
                    </Table.Td>
                    <Table.Td>
                      <PassScoreCell summary={r.summary} severity={r.severity} />
                    </Table.Td>
                    <Table.Td>
                      {r.durationMs !== undefined ? (
                        <Text size="xs" ff="monospace">
                          {formatDurationMs(r.durationMs)}
                        </Text>
                      ) : (
                        <Text size="xs" c="dimmed">
                          —
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {r.runTag ? (
                        <Tooltip label={r.runTag} withArrow>
                          <Group gap={3} wrap="wrap" maw={140}>
                            {/* Tags are a filter record, not a status. As outlined
                                blue chips they out-shouted the pass rate — the
                                one number this table exists to show. */}
                            {parseTagExpr(r.runTag)
                              .slice(0, 3)
                              .map((tag) => (
                                <Text key={tag} size="xs" c="dimmed" ff="monospace">
                                  {tag.replace(/^@/, '')}
                                </Text>
                              ))}
                            {parseTagExpr(r.runTag).length > 3 && (
                              <Text size="xs" c="dimmed">
                                +{parseTagExpr(r.runTag).length - 3}
                              </Text>
                            )}
                          </Group>
                        </Tooltip>
                      ) : (
                        <Text size="xs" c="dimmed">
                          {t('reports.allTests')}
                        </Text>
                      )}
                    </Table.Td>
                    {advancedMode && (
                      <Table.Td>
                        {r.runMode ? (
                          <Badge
                            size="xs"
                            variant="light"
                            color={r.runMode === 'docker' ? 'violet' : 'gray'}
                          >
                            {r.runMode}
                          </Badge>
                        ) : (
                          <Text size="xs" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>
                    )}
                    <Table.Td>
                      <Tooltip label={formatAbsolute(r.timestamp)} withArrow>
                        <Text size="xs" c="dimmed">
                          {formatRelative(r.timestamp)}
                        </Text>
                      </Tooltip>
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs">
                        <Button
                          size="compact-xs"
                          leftSection={<TbExternalLink size={12} />}
                          onClick={async () => {
                            // Ask the server to open the report with the OS
                            // default app so it loads as a real file:// path.
                            // (A localhost page can't navigate to file://.)
                            try {
                              await api.post('/api/reports/open-file', { path: r.reportPath });
                            } catch {
                              toast.error(t('reports.openFailed'));
                            }
                          }}
                        >
                          {t('reports.open')}
                        </Button>
                        {r.tool === 'playwright' && <ArtifactMenu reportPath={r.reportPath} />}
                        {/* Lock and delete stay as their own icons rather than
                            collapsing into a `⋯` menu: ArtifactMenu already owns a
                            `⋯` on this row, so a second identical trigger beside it
                            was ambiguous, and the table scrolls horizontally, so
                            the column has room. Delete still confirms first. */}
                        <Tooltip
                          label={r.favorite ? t('reports.unfavorite') : t('reports.favorite')}
                        >
                          <ActionIcon
                            variant="subtle"
                            color={r.favorite ? 'yellow' : 'gray'}
                            size="sm"
                            onClick={() =>
                              favoriteMutation.mutate({ path: r.reportPath, on: !r.favorite })
                            }
                            aria-label={
                              r.favorite ? t('reports.unfavorite') : t('reports.favorite')
                            }
                          >
                            {r.favorite ? <TbStarFilled size={14} /> : <TbStar size={14} />}
                          </ActionIcon>
                        </Tooltip>
                        {/* Disabled while favourited: the favourite owns the lock,
                            so offering an unlock that the server would refuse is
                            worse than showing the reason. Rendered always (never
                            hidden) so the row's icons never shift position. */}
                        <Tooltip
                          label={
                            r.favorite
                              ? t('reports.lockedByFavorite')
                              : r.locked
                                ? t('reports.unlockHint')
                                : t('reports.lockHint')
                          }
                        >
                          <ActionIcon
                            variant="subtle"
                            color={r.locked ? 'yellow' : 'gray'}
                            size="sm"
                            disabled={r.favorite}
                            onClick={() =>
                              r.locked
                                ? unlockMutation.mutate(r.reportPath)
                                : lockMutation.mutate(r.reportPath)
                            }
                            aria-label={
                              r.locked ? t('reports.unlockReport') : t('reports.lockReport')
                            }
                          >
                            {r.locked ? <TbLock size={14} /> : <TbLockOpen size={14} />}
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip
                          label={
                            r.favorite ? t('reports.favoriteNoDelete') : t('reports.deleteAria')
                          }
                        >
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            size="sm"
                            disabled={r.favorite}
                            onClick={() => handleDelete(r.reportPath)}
                            aria-label={t('reports.deleteAria')}
                          >
                            <TbTrash size={14} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Paper>
      )}

      {/* Pagination controls */}
      {totalPages > 1 && (
        <Group justify="center" style={{ flexShrink: 0 }}>
          <Pagination
            value={safePage}
            onChange={setCurrentPage}
            total={totalPages}
            size="sm"
            withEdges
          />
        </Group>
      )}
    </Stack>
  );
}
