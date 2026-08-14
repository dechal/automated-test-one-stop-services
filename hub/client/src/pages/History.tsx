import type { RunRecord, RunRequest, RunStatus, ToolId } from '@hub/shared';
import { type FailedRunSelection, parseTagExpr } from '@hub/shared';
import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Group,
  Menu,
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
import { useDebouncedValue, useDisclosure } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useCallback, useMemo, useState } from 'react';
import {
  TbCalendar,
  TbCopy,
  TbDots,
  TbDownload,
  TbFilter,
  TbGitCompare,
  TbHistory,
  TbPlayerPlay,
  TbRefreshAlert,
  TbTerminal,
  TbTrash,
} from 'react-icons/tb';
import { api } from '~/api/client.js';
import { qRunsHistory } from '~/api/queries.js';
import { confirmDialog } from '~/components/confirmDialog';
import { EmptyState } from '~/components/EmptyState.js';
import { ErrorState } from '~/components/ErrorState.js';
import { RunLogModal } from '~/components/history/RunLogModal.js';
import { PageHeader } from '~/components/PageHeader.js';
import { PassScoreCell } from '~/components/PassScoreCell.js';
import { toast } from '~/components/Toast.js';
import { PAGE_SIZE_OPTIONS, SortableHeader } from '~/components/table/SortableHeader.js';
import { useTableSort } from '~/hooks/useTableSort.js';
import { useTools } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';
import { usePreferences } from '~/stores/hub.js';
import { useNavigationStore } from '~/stores/navigation.js';
import { formatAbsolute, formatDurationBetween, formatRelative } from '~/utils/datetime.js';
import { getStatusColor, getStatusIcon, runOutcome } from '~/utils/run-status.js';
import { buildTagQuery } from '~/utils/tag-selection.js';
import { toolLabel } from '~/utils/tool-label.js';

const ALL_STATUSES: RunStatus[] = ['passed', 'failed'];

type SortField = 'startedAt' | 'endedAt' | 'project' | 'tool' | 'status';

export function HistoryPage() {
  const t = useT();
  const navigate = useNavigate();
  const setPendingRunConfig = useNavigationStore((s) => s.setPendingRunConfig);
  const onRerun = useCallback(
    (config: RunRequest) => {
      setPendingRunConfig(config);
      navigate({ to: '/run' });
    },
    [navigate, setPendingRunConfig],
  );
  const queryClient = useQueryClient();
  const [selectedTools, setSelectedTools] = useState<Set<ToolId>>(new Set());
  const [selectedStatuses, setSelectedStatuses] = useState<Set<RunStatus>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [filterProject, setFilterProject] = useState('');
  // Mantine ships an idiomatic debounced-value hook; replaces lodash debounce.
  const [debouncedFilter] = useDebouncedValue(filterProject, 300);
  const handleFilterChange = (v: string) => {
    setFilterProject(v);
    setCurrentPage(1);
  };
  const [dateRange, setDateRange] = useState<[DateValue, DateValue]>([null, null]);
  const [showFilters, setShowFilters] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const { sortField, sortDir, handleSort } = useTableSort<SortField>('startedAt');
  const [logModalOpen, { open: openLog, close: closeLog }] = useDisclosure(false);
  const [selectedRun, setSelectedRun] = useState<RunRecord | null>(null);
  // Up to two runs picked for the compare view (A vs B).
  const [compareSel, setCompareSel] = useState<Set<string>>(new Set());
  // The raw exit code is engineering metadata: shown only in advanced mode. Sort
  // state is untouched when a hidden column is the active sort field.
  const advancedMode = usePreferences((s) => s.advancedMode);

  const history = useQuery(qRunsHistory());

  const tools = useTools().data ?? [];
  const toolIds = tools.filter((t) => t.status === 'enabled').map((t) => t.id as ToolId);

  const clearHistoryMutation = useMutation({
    mutationFn: () => api.delete('/api/runs/history'),
    onSuccess: () => {
      toast.success(t('history.cleared'));
      queryClient.invalidateQueries({ queryKey: ['runs-history'] });
    },
    onError: () => toast.error(t('history.clearFailed')),
  });

  const availableTypes = [...new Set((history.data ?? []).map((r) => r.request.type))].sort();

  function toggleInSet<T>(set: Set<T>, value: T): Set<T> {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  }

  function handleViewLog(run: RunRecord) {
    setSelectedRun(run);
    openLog();
  }

  function handleCopyCommand(command: string) {
    navigator.clipboard.writeText(command);
    toast.success(t('history.commandCopied'));
  }

  function handleRerun(run: RunRecord) {
    onRerun(run.request);
  }

  /**
   * Re-run only the cases that failed in this run.
   *
   * The failed set comes from the server, which reads the run's own
   * `results.json` — Playwright's `--last-failed` cannot work here because its
   * state file is deleted by the output cleanup (brain LESS-074). This also means
   * ANY run in history can be narrowed, not just the latest.
   */
  const rerunFailed = useMutation({
    mutationFn: (run: RunRecord) =>
      api.get<FailedRunSelection>(`/api/runs/${run.id}/failed`).then((res) => ({ run, res })),
    onSuccess: ({ run, res }) => {
      if (res.caseIds.length === 0) {
        toast.error(
          res.failed === 0
            ? t('history.rerunFailedNone')
            : `${t('history.rerunFailedUntagged')} (${res.unidentified.length})`,
        );
        return;
      }
      if (res.unidentified.length > 0) {
        // Partial selection is still useful — say what could not be included.
        toast.error(`${t('history.rerunFailedUntagged')} (${res.unidentified.length})`);
      }
      // Per-tool syntax: Robot rejects a Playwright regex outright, so a Robot
      // rerun built with `buildTagExpr` could never match.
      onRerun({ ...run.request, tag: buildTagQuery(run.request.tool, res.caseIds) });
    },
  });

  function toggleCompare(id: string) {
    setCompareSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 2) next.add(id); // cap at two — a diff is always A vs B
      return next;
    });
  }

  function handleCompare() {
    const runs = (history.data ?? []).filter((r) => compareSel.has(r.id));
    if (runs.length !== 2) return;
    // Baseline = older run (A), target = newer run (B), so the diff reads forward in time.
    const ordered = [...runs].sort((x, y) => x.startedAt.localeCompare(y.startedAt));
    const older = ordered[0];
    const newer = ordered[1];
    if (!older || !newer) return;
    navigate({ to: '/compare', search: { a: older.id, b: newer.id } });
  }

  function exportCsv() {
    const rows = sorted.map((r) => ({
      id: r.id,
      tool: r.request.tool,
      type: r.request.type,
      project: r.request.project,
      status: r.status,
      mode: r.request.mode,
      triggeredBy: r.triggeredBy ?? 'manual',
      tag: r.request.tag ?? '',
      cases: r.summary ? r.summary.passed + r.summary.failed + (r.summary.skipped ?? 0) : '',
      passed: r.summary?.passed ?? '',
      failed: r.summary?.failed ?? '',
      startedAt: r.startedAt,
      endedAt: r.endedAt ?? '',
      duration: formatDurationBetween(r.startedAt, r.endedAt),
      exitCode: r.exitCode ?? '',
      command: r.command,
    }));
    const headers = Object.keys(rows[0] ?? {});
    const csv = [
      headers.join(','),
      ...rows.map((row) =>
        headers
          .map((h) => `"${String((row as Record<string, unknown>)[h] ?? '').replace(/"/g, '""')}"`)
          .join(','),
      ),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `run-history-${dayjs().format('YYYY-MM-DD')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const filtered = useMemo(
    () =>
      (history.data ?? []).filter((r) => {
        if (selectedTools.size > 0 && !selectedTools.has(r.request.tool)) return false;
        if (selectedStatuses.size > 0 && !selectedStatuses.has(r.status)) return false;
        if (selectedTypes.size > 0 && !selectedTypes.has(r.request.type)) return false;
        if (
          debouncedFilter &&
          !r.request.project.toLowerCase().includes(debouncedFilter.toLowerCase())
        )
          return false;
        const [from, to] = dateRange;
        if (from || to) {
          const runDay = dayjs(r.startedAt);
          if (!runDay.isValid()) return false;
          if (from && runDay.isBefore(dayjs(from).startOf('day'))) return false;
          if (to && runDay.isAfter(dayjs(to).endOf('day'))) return false;
        }
        return true;
      }),
    [history.data, selectedTools, selectedStatuses, selectedTypes, debouncedFilter, dateRange],
  );

  const sorted = useMemo(
    () =>
      [...filtered].sort((a, b) => {
        let cmp = 0;
        switch (sortField) {
          case 'startedAt':
            cmp = a.startedAt.localeCompare(b.startedAt);
            break;
          case 'endedAt':
            cmp = (a.endedAt ?? '').localeCompare(b.endedAt ?? '');
            break;
          case 'project':
            cmp = a.request.project.localeCompare(b.request.project);
            break;
          case 'tool':
            cmp = a.request.tool.localeCompare(b.request.tool);
            break;
          case 'status':
            cmp = a.status.localeCompare(b.status);
            break;
        }
        return sortDir === 'asc' ? cmp : -cmp;
      }),
    [filtered, sortField, sortDir],
  );

  const totalPages = Math.ceil(sorted.length / pageSize);
  const safePage = Math.min(currentPage, totalPages || 1);
  const paginatedData = sorted.slice((safePage - 1) * pageSize, safePage * pageSize);

  /**
   * Same rule as Reports: a column identical on every visible row is repetition,
   * not information. It folds away and its one value is shown above the table, so
   * this 12-column grid loses two columns without losing any data.
   */
  const sharedProject =
    paginatedData.length > 1 &&
    paginatedData.every((r) => r.request.project === paginatedData[0]?.request.project)
      ? (paginatedData[0]?.request.project ?? null)
      : null;
  const sharedType =
    paginatedData.length > 1 &&
    paginatedData.every((r) => r.request.type === paginatedData[0]?.request.type)
      ? (paginatedData[0]?.request.type ?? null)
      : null;

  const activeFilterCount =
    (selectedTools.size > 0 ? 1 : 0) +
    (selectedStatuses.size > 0 ? 1 : 0) +
    (selectedTypes.size > 0 ? 1 : 0) +
    (debouncedFilter ? 1 : 0) +
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
          title={t('history.title')}
          description={t('nav.history.desc')}
          actions={
            <>
              {compareSel.size === 2 && (
                <Button
                  size="xs"
                  color="grape"
                  leftSection={<TbGitCompare size={14} />}
                  onClick={handleCompare}
                >
                  {t('compare.button')} (2)
                </Button>
              )}
              {sorted.length > 0 && (
                <Button
                  variant="default"
                  size="xs"
                  leftSection={<TbDownload size={14} />}
                  onClick={exportCsv}
                >
                  {t('history.exportCsv')}
                </Button>
              )}
              {sorted.length > 0 && (
                <Button
                  variant="light"
                  color="red"
                  size="xs"
                  leftSection={<TbTrash size={14} />}
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: t('history.clearTitle'),
                      message: t('history.clearConfirm'),
                      confirmLabel: t('history.clearAll'),
                      danger: true,
                    });
                    if (ok) clearHistoryMutation.mutate();
                  }}
                  loading={clearHistoryMutation.isPending}
                >
                  {t('history.clearHistory')}
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
                {t('history.filterRuns')}
              </Text>
              {activeFilterCount > 0 && (
                <Button size="compact-xs" variant="subtle" color="gray" onClick={clearFilters}>
                  {t('common.clearAll')}
                </Button>
              )}
            </Group>

            <Group grow align="flex-end">
              <DatePickerInput
                type="range"
                label={t('table.dateRange')}
                size="xs"
                value={dateRange}
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
                  handleFilterChange(e.currentTarget.value);
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

      {/* The values whose columns folded away because every visible row shared
          them. Shown once so the fold hides nothing. */}
      {(sharedProject !== null || sharedType !== null) && (
        <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
          <Text size="xs" c="dimmed">
            {t('status.sameForAllRows')}
          </Text>
          {sharedProject !== null && (
            <Badge size="sm" variant="light" color="gray">
              {sharedProject}
            </Badge>
          )}
          {sharedType !== null && (
            <Badge size="sm" variant="light" color="gray">
              {sharedType}
            </Badge>
          )}
        </Group>
      )}

      {history.data && (
        <Group justify="space-between" style={{ flexShrink: 0 }} wrap="nowrap">
          <Text size="xs" c="dimmed">
            {t('filter.showing')} {paginatedData.length} {t('filter.of')} {sorted.length}{' '}
            {t('history.runsWord')}
            {sorted.length !== history.data.length &&
              ` (${history.data.length} ${t('history.totalSuffix')})`}
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
      {history.isLoading && (
        <Paper withBorder p="md" style={{ flexShrink: 0 }}>
          <Stack gap="xs">
            {Array.from({ length: 8 }).map((_, i) => (
              <Group key={i as number} gap="md" wrap="nowrap">
                <Skeleton height={20} width={60} radius="sm" />
                <Skeleton height={20} width={80} radius="sm" />
                <Skeleton height={20} style={{ flex: 1 }} radius="sm" />
                <Skeleton height={20} width={60} radius="sm" />
                <Skeleton height={20} width={100} radius="sm" />
              </Group>
            ))}
          </Stack>
        </Paper>
      )}

      {/* Empty state */}
      {history.isError && (
        <div style={{ flexShrink: 0 }}>
          <ErrorState onRetry={() => history.refetch()} />
        </div>
      )}
      {!history.isLoading && !history.isError && sorted.length === 0 && (
        <div style={{ flexShrink: 0 }}>
          <EmptyState
            icon={<TbHistory size={48} color="var(--mantine-color-dimmed)" />}
            description={activeFilterCount > 0 ? t('history.noMatchFilter') : t('history.noRuns')}
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
                  {t('history.startRun')}
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
          {/* Bounded ScrollArea → table scrolls inside the card (sticky header)
              instead of growing the page; pagination below stays visible. */}
          <ScrollArea type="auto" style={{ flex: 1, minHeight: 0 }}>
            <Table
              striped
              highlightOnHover
              verticalSpacing="xs"
              stickyHeader
              miw={advancedMode ? 1200 : 1060}
            >
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={40} />
                  <Table.Th>
                    <SortableHeader
                      label={t('table.status')}
                      field="status"
                      currentField={sortField}
                      currentDir={sortDir}
                      onSort={handleSort}
                    />
                  </Table.Th>
                  <Table.Th>
                    <SortableHeader
                      label={t('run.tool')}
                      field="tool"
                      currentField={sortField}
                      currentDir={sortDir}
                      onSort={handleSort}
                    />
                  </Table.Th>
                  {sharedProject === null && (
                    <Table.Th>
                      <SortableHeader
                        label={t('run.project')}
                        field="project"
                        currentField={sortField}
                        currentDir={sortDir}
                        onSort={handleSort}
                      />
                    </Table.Th>
                  )}
                  {sharedType === null && <Table.Th>{t('table.type')}</Table.Th>}
                  <Table.Th>{t('table.cases')}</Table.Th>
                  <Table.Th>{t('table.passScore')}</Table.Th>
                  <Table.Th>{t('table.tag')}</Table.Th>
                  <Table.Th>{t('table.mode')}</Table.Th>
                  <Table.Th>{t('table.trigger')}</Table.Th>
                  <Table.Th>{t('table.duration')}</Table.Th>
                  <Table.Th>
                    <SortableHeader
                      label={t('table.started')}
                      field="startedAt"
                      currentField={sortField}
                      currentDir={sortDir}
                      onSort={handleSort}
                    />
                  </Table.Th>
                  {advancedMode && <Table.Th>{t('table.exit')}</Table.Th>}
                  <Table.Th>{t('table.actions')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {paginatedData.map((r) => (
                  <Table.Tr key={r.id}>
                    <Table.Td>
                      <Checkbox
                        size="xs"
                        checked={compareSel.has(r.id)}
                        onChange={() => toggleCompare(r.id)}
                        aria-label={t('compare.button')}
                      />
                    </Table.Td>
                    <Table.Td>
                      {/* Same outcome vocabulary as Reports: a run whose tests
                          failed and a run that never produced a result are
                          different problems and must not read alike. */}
                      <Badge
                        color={runOutcome(r.status, r.summary).color}
                        variant={runOutcome(r.status, r.summary).emphasise ? 'filled' : 'light'}
                        size="sm"
                        leftSection={runOutcome(r.status, r.summary).icon}
                      >
                        {t(runOutcome(r.status, r.summary).labelKey)}
                      </Badge>
                    </Table.Td>
                    {/* Tool / mode / trigger are context, not signals. As pills
                        they gave every row five coloured chips and nothing stood
                        out; as dim text the status badge is the only colour in
                        the row and the eye lands on it. */}
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {toolLabel(r.request.tool, tools)}
                      </Text>
                    </Table.Td>
                    {sharedProject === null && (
                      <Table.Td>
                        <Tooltip label={`${r.request.tool}/${r.request.type}/${r.request.project}`}>
                          <Text size="xs" fw={500} truncate maw={160}>
                            {r.request.project}
                          </Text>
                        </Tooltip>
                      </Table.Td>
                    )}
                    {sharedType === null && (
                      <Table.Td>
                        <Text size="xs" truncate maw={80}>
                          {r.request.type}
                        </Text>
                      </Table.Td>
                    )}
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {r.summary
                          ? `${r.summary.passed + r.summary.failed + (r.summary.skipped ?? 0)}`
                          : '—'}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <PassScoreCell summary={r.summary} severity={r.severity} />
                    </Table.Td>
                    <Table.Td>
                      {r.request.tag ? (
                        <Tooltip label={r.request.tag} withArrow>
                          {/* One line, same rule as the Reports tag cell: stacked
                              chips made these rows twice the height of their
                              neighbours and the eye lost the row rhythm. The
                              tooltip still carries the full expression. */}
                          <Group gap={4} wrap="nowrap" maw={130}>
                            <Badge size="xs" variant="outline" color="blue" style={{ minWidth: 0 }}>
                              {(parseTagExpr(r.request.tag)[0] ?? '').replace(/^@/, '')}
                            </Badge>
                            {parseTagExpr(r.request.tag).length > 1 && (
                              <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                                +{parseTagExpr(r.request.tag).length - 1}
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
                    <Table.Td>
                      {/* Docker is the exception worth marking, local is the
                          norm — so only the exception gets any colour. */}
                      <Text size="xs" c={r.request.mode === 'docker' ? 'violet.4' : 'dimmed'}>
                        {r.request.mode}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {t(`trigger.${r.triggeredBy ?? 'manual'}`)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" ff="monospace">
                        {formatDurationBetween(r.startedAt, r.endedAt)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Tooltip label={formatAbsolute(r.startedAt)}>
                        <Text size="xs" c="dimmed">
                          {formatRelative(r.startedAt)}
                        </Text>
                      </Tooltip>
                    </Table.Td>
                    {advancedMode && (
                      <Table.Td>
                        <Text size="xs" ff="monospace" c={r.exitCode === 0 ? 'green' : 'red'}>
                          {r.exitCode ?? '-'}
                        </Text>
                      </Table.Td>
                    )}
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <Tooltip label={t('history.rerun')}>
                          <ActionIcon
                            variant="light"
                            color="green"
                            size="sm"
                            onClick={() => handleRerun(r)}
                            aria-label={t('history.rerun')}
                          >
                            <TbPlayerPlay size={12} />
                          </ActionIcon>
                        </Tooltip>
                        {/* Secondary actions live behind one trigger. Four
                            buttons per row put ~125 targets on a 25-row page and
                            ate the width the data columns needed; the two most
                            used stay out, the rest are one click away. */}
                        <Menu position="bottom-end" withArrow>
                          <Menu.Target>
                            <ActionIcon
                              variant="subtle"
                              color="gray"
                              size="sm"
                              aria-label={t('history.moreActions')}
                            >
                              <TbDots size={14} />
                            </ActionIcon>
                          </Menu.Target>
                          <Menu.Dropdown>
                            {/* Only offered where there is something to narrow
                                to — a green run has no failures to re-select. */}
                            {(r.status === 'failed' || r.status === 'error') && (
                              <Menu.Item
                                leftSection={<TbRefreshAlert size={14} />}
                                onClick={() => rerunFailed.mutate(r)}
                              >
                                {t('history.rerunFailed')}
                              </Menu.Item>
                            )}
                            <Menu.Item
                              leftSection={<TbCopy size={14} />}
                              onClick={() => handleCopyCommand(r.command)}
                            >
                              {t('history.copyCommand')}
                            </Menu.Item>
                          </Menu.Dropdown>
                        </Menu>
                        <Button
                          size="compact-xs"
                          variant="light"
                          leftSection={<TbTerminal size={12} />}
                          onClick={() => handleViewLog(r)}
                        >
                          {t('history.details')}
                        </Button>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Paper>
      )}

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

      {/* Log viewer modal */}
      <RunLogModal run={selectedRun} opened={logModalOpen} onClose={closeLog} onRerun={onRerun} />
    </Stack>
  );
}
