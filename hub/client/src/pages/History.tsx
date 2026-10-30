import type { FailedRunSelection, RunRecord, RunRequest, RunStatus, ToolId } from '@hub/shared';
import {
  Badge,
  Button,
  Group,
  Pagination,
  Paper,
  Select,
  Skeleton,
  Stack,
  Text,
} from '@mantine/core';
import type { DateValue } from '@mantine/dates';
import { useDebouncedValue, useDisclosure } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useCallback, useMemo, useState } from 'react';
import {
  TbDownload,
  TbFilter,
  TbGitCompare,
  TbHistory,
  TbPlayerPlay,
  TbTrash,
} from 'react-icons/tb';
import { api } from '~/api/client.js';
import { qRunsHistory } from '~/api/queries.js';
import { confirmDialog } from '~/components/confirmDialog';
import { EmptyState } from '~/components/EmptyState.js';
import { ErrorState } from '~/components/ErrorState.js';
import { HistoryFilterPanel } from '~/components/history/HistoryFilterPanel.js';
import { HistoryRunsTable, type HistorySortField } from '~/components/history/HistoryRunsTable.js';
import { exportHistoryCsv } from '~/components/history/history-csv.js';
import { RunLogModal } from '~/components/history/RunLogModal.js';
import { PageHeader } from '~/components/PageHeader.js';
import { toast } from '~/components/Toast.js';
import { PAGE_SIZE_OPTIONS } from '~/components/table/SortableHeader.js';
import { useTableSort } from '~/hooks/useTableSort.js';
import { useTools } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';
import { usePreferences } from '~/stores/hub.js';
import { useNavigationStore } from '~/stores/navigation.js';
import { buildTagQuery } from '~/utils/tag-selection.js';

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
  const { sortField, sortDir, handleSort } = useTableSort<HistorySortField>('startedAt');
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
    exportHistoryCsv(sorted);
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
          title={t('nav.history')}
          description={t('nav.history.desc')}
          actions={
            <>
              {compareSel.size === 2 && (
                <Button
                  size="xs"
                  variant="light"
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
              {sorted.length > 0 && (
                <Button
                  variant="subtle"
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
            </>
          }
        />
      </div>

      {showFilters && (
        <HistoryFilterPanel
          activeFilterCount={activeFilterCount}
          clearFilters={clearFilters}
          dateRange={dateRange}
          setDateRange={setDateRange}
          filterProject={filterProject}
          handleFilterChange={handleFilterChange}
          toolIds={toolIds}
          selectedTools={selectedTools}
          setSelectedTools={setSelectedTools}
          availableTypes={availableTypes}
          selectedTypes={selectedTypes}
          setSelectedTypes={setSelectedTypes}
          selectedStatuses={selectedStatuses}
          setSelectedStatuses={setSelectedStatuses}
          setCurrentPage={setCurrentPage}
        />
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
        <HistoryRunsTable
          paginatedData={paginatedData}
          tools={tools}
          sharedProject={sharedProject}
          sharedType={sharedType}
          advancedMode={advancedMode}
          sortField={sortField}
          sortDir={sortDir}
          handleSort={handleSort}
          compareSel={compareSel}
          toggleCompare={toggleCompare}
          handleRerun={handleRerun}
          onRerunFailed={(run) => rerunFailed.mutate(run)}
          handleCopyCommand={handleCopyCommand}
          handleViewLog={handleViewLog}
        />
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
