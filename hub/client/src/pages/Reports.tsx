import type { ReportEntry, ToolId } from '@hub/shared';
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import {
  TbAlertTriangle,
  TbFilter,
  TbPlayerPlay,
  TbReportAnalytics,
  TbTrash,
} from 'react-icons/tb';
import { api } from '~/api/client.js';
import { confirmDialog } from '~/components/confirmDialog.js';
import { EmptyState } from '~/components/EmptyState.js';
import { ErrorState } from '~/components/ErrorState.js';
import { PageHeader } from '~/components/PageHeader.js';
import { ReportsFilterPanel } from '~/components/reports/ReportsFilterPanel.js';
import { type ReportsSortField, ReportsTable } from '~/components/reports/ReportsTable.js';
import { toast } from '~/components/Toast.js';
import { PAGE_SIZE_OPTIONS } from '~/components/table/SortableHeader.js';
import { useTableSort } from '~/hooks/useTableSort.js';
import { useTools } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';
import { usePreferences } from '~/stores/hub.js';
import { isCrashReport, isHubOrigin } from '~/utils/report-origin.js';
import { toggleInSet } from '~/utils/toggle-in-set.js';

// The server emits report timestamps as ISO-8601 strings (same shape as a
// run's `startedAt`), so they parse with a plain `dayjs(iso)` — no month-name
// custom format, and they sort chronologically as strings.

export function ReportsPage() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedTools, setSelectedTools] = useState<Set<ToolId>>(new Set());
  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [filterProject, setFilterProject] = useState('');
  const [hideLocalOrigin, setHideLocalOrigin] = useState(false);
  const [dateRange, setDateRange] = useState<[DateValue, DateValue]>([null, null]);
  const [showFilters, setShowFilters] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const { sortField, sortDir, handleSort } = useTableSort<ReportsSortField>('timestamp');
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
      toast.success(t('reports.reportDeleted'), { id: `report-del-${Date.now()}` });
    },
    onError: (err) => {
      const code = (err as Error & { code?: string }).code;
      toast.error(code === 'REPORT_LOCKED' ? t('reports.deleteLocked') : t('reports.deleteFailed'));
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (paths: string[]) => {
      let deleted = 0;
      let locked = 0;
      let failed = 0;
      for (const p of paths) {
        try {
          await api.delete(`/api/reports?path=${encodeURIComponent(p)}`);
          deleted += 1;
        } catch (err) {
          if ((err as Error & { code?: string }).code === 'REPORT_LOCKED') locked += 1;
          else failed += 1;
        }
      }
      return { deleted, total: paths.length, locked, failed };
    },
    onSuccess: ({ deleted, total, locked, failed }) => {
      queryClient.invalidateQueries({ queryKey: ['reports'] });
      setSelectedRows(new Set());
      toast.success(`${t('reports.reportsDeleted')} (${deleted}/${total})`, {
        id: `reports-del-${Date.now()}`,
      });
      if (locked > 0) {
        toast.error(t('reports.deleteLocked'), { id: `reports-del-locked-${Date.now()}` });
      }
      if (failed > 0) {
        toast.error(t('reports.deleteSomeFailed'), { id: `reports-del-failed-${Date.now()}` });
      }
    },
    onError: (err) => {
      const code = (err as Error & { code?: string }).code;
      toast.error(
        code === 'REPORT_LOCKED' ? t('reports.deleteLocked') : t('reports.deleteSomeFailed'),
      );
    },
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

  const crashes = (reports.data ?? []).filter((r) => isCrashReport(r) && !r.locked);

  async function handleCleanupCrashes() {
    if (crashes.length === 0) {
      toast.info(t('reports.cleanupNothing'), { id: `cleanup-none-${Date.now()}` });
      return;
    }
    const ok = await confirmDialog({
      title: t('reports.cleanupCrashesTitle'),
      message: `${t('common.delete')} ${crashes.length} ${t('reports.reportsWord')} — ${t('reports.cannotUndo')}`,
      confirmLabel: `${t('common.delete')} ${crashes.length}`,
      danger: true,
    });
    if (ok) {
      bulkDeleteMutation.mutate(crashes.map((r) => r.reportPath));
    }
  }

  const availableTypes = [...new Set((reports.data ?? []).map((r) => r.type))].sort();

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
        if (hideLocalOrigin && !isHubOrigin(r)) return false;
        const [from, to] = dateRange;
        if (from || to) {
          const reportDay = dayjs(r.timestamp);
          if (!reportDay.isValid()) return false;
          if (from && reportDay.isBefore(dayjs(from).startOf('day'))) return false;
          if (to && reportDay.isAfter(dayjs(to).endOf('day'))) return false;
        }
        return true;
      }),
    [
      reports.data,
      selectedTools,
      selectedStatuses,
      selectedTypes,
      filterProject,
      hideLocalOrigin,
      dateRange,
    ],
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

  /**
   * A column whose value is identical on every visible row carries no
   * information — it only repeats. Filtering to one project made `project` and
   * `type` do exactly that, 25 rows deep. The column folds away and its single
   * value is shown once above the table instead, so two columns of noise go
   * without any data leaving the page.
   */
  const sharedProject =
    paginatedData.length > 1 && paginatedData.every((r) => r.project === paginatedData[0]?.project)
      ? (paginatedData[0]?.project ?? null)
      : null;
  const sharedType =
    paginatedData.length > 1 && paginatedData.every((r) => r.type === paginatedData[0]?.type)
      ? (paginatedData[0]?.type ?? null)
      : null;

  const activeFilterCount =
    (selectedTools.size > 0 ? 1 : 0) +
    (selectedStatuses.size > 0 ? 1 : 0) +
    (selectedTypes.size > 0 ? 1 : 0) +
    (filterProject ? 1 : 0) +
    (hideLocalOrigin ? 1 : 0) +
    (dateRange[0] || dateRange[1] ? 1 : 0);

  function clearFilters() {
    setSelectedTools(new Set());
    setSelectedStatuses(new Set());
    setSelectedTypes(new Set());
    setFilterProject('');
    setHideLocalOrigin(false);
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
          title={t('nav.reports')}
          description={t('nav.reports.desc')}
          actions={
            <>
              {selectedRows.size > 0 && (
                <Button
                  color="red"
                  size="xs"
                  variant="subtle"
                  leftSection={<TbTrash size={14} />}
                  onClick={handleBulkDelete}
                  loading={bulkDeleteMutation.isPending}
                >
                  {t('common.delete')} {selectedRows.size}
                </Button>
              )}
              {crashes.length > 0 && (
                <Button
                  color="red"
                  size="xs"
                  variant="subtle"
                  leftSection={<TbAlertTriangle size={14} />}
                  onClick={handleCleanupCrashes}
                  loading={bulkDeleteMutation.isPending}
                >
                  {t('reports.cleanupCrashes')} {crashes.length}
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
        <ReportsFilterPanel
          activeFilterCount={activeFilterCount}
          clearFilters={clearFilters}
          hideLocalOrigin={hideLocalOrigin}
          setHideLocalOrigin={setHideLocalOrigin}
          dateRange={dateRange}
          setDateRange={setDateRange}
          filterProject={filterProject}
          setFilterProject={setFilterProject}
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

      {/* The values whose columns folded away because every row shared them.
          Shown once so the fold hides nothing. */}
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
        <ReportsTable
          paginatedData={paginatedData}
          selectablePaths={selectablePaths}
          selectedRows={selectedRows}
          advancedMode={advancedMode}
          sharedProject={sharedProject}
          sharedType={sharedType}
          sortField={sortField}
          sortDir={sortDir}
          handleSort={handleSort}
          toggleRow={toggleRow}
          toggleAllRows={toggleAllRows}
          onFavorite={(path, on) => favoriteMutation.mutate({ path, on })}
          onLock={(reportPath) => lockMutation.mutate(reportPath)}
          onUnlock={(reportPath) => unlockMutation.mutate(reportPath)}
          handleDelete={handleDelete}
        />
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
