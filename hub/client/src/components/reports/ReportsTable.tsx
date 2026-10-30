import type { ReportEntry } from '@hub/shared';
import { Checkbox, Paper, ScrollArea, Table } from '@mantine/core';
import { ReportRow } from '~/components/reports/ReportRow.js';
import { SortableHeader, type SortDir } from '~/components/table/SortableHeader.js';
import { useT } from '~/i18n/index.js';

export type ReportsSortField = 'timestamp' | 'tool' | 'project' | 'type' | 'status';

export interface ReportsTableProps {
  paginatedData: ReportEntry[];
  selectablePaths: string[];
  selectedRows: Set<string>;
  advancedMode: boolean;
  sharedProject: string | null;
  sharedType: string | null;
  sortField: ReportsSortField;
  sortDir: SortDir;
  handleSort: (field: ReportsSortField) => void;
  toggleRow: (reportPath: string) => void;
  toggleAllRows: (paths: string[]) => void;
  onFavorite: (path: string, on: boolean) => void;
  onLock: (reportPath: string) => void;
  onUnlock: (reportPath: string) => void;
  handleDelete: (reportPath: string) => void;
}

export function ReportsTable({
  paginatedData,
  selectablePaths,
  selectedRows,
  advancedMode,
  sharedProject,
  sharedType,
  sortField,
  sortDir,
  handleSort,
  toggleRow,
  toggleAllRows,
  onFavorite,
  onLock,
  onUnlock,
  handleDelete,
}: ReportsTableProps) {
  const t = useT();
  return (
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
          miw={advancedMode ? 1430 : 1150}
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
                    selectablePaths.length > 0 && selectablePaths.every((p) => selectedRows.has(p))
                  }
                  indeterminate={
                    selectablePaths.some((p) => selectedRows.has(p)) &&
                    !selectablePaths.every((p) => selectedRows.has(p))
                  }
                  onChange={() => toggleAllRows(selectablePaths)}
                  aria-label={t('reports.selectAll')}
                />
              </Table.Th>
              <Table.Th w={1}>
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
              {sharedType === null && (
                <Table.Th>
                  <SortableHeader
                    label={t('run.type')}
                    field="type"
                    currentField={sortField}
                    currentDir={sortDir}
                    onSort={handleSort}
                  />
                </Table.Th>
              )}
              <Table.Th>{t('reports.cases')}</Table.Th>
              <Table.Th>{t('reports.passScore')}</Table.Th>
              <Table.Th>{t('table.duration')}</Table.Th>
              <Table.Th>{t('table.tag')}</Table.Th>
              {advancedMode && <Table.Th>{t('table.mode')}</Table.Th>}
              <Table.Th>{t('table.environment')}</Table.Th>
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
              <ReportRow
                key={r.id}
                r={r}
                selected={selectedRows.has(r.reportPath)}
                advancedMode={advancedMode}
                sharedProject={sharedProject}
                sharedType={sharedType}
                toggleRow={toggleRow}
                onFavorite={onFavorite}
                onLock={onLock}
                onUnlock={onUnlock}
                handleDelete={handleDelete}
              />
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>
    </Paper>
  );
}
