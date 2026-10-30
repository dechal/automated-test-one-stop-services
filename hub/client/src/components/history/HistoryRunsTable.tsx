import type { RunRecord, ToolView } from '@hub/shared';
import { Paper, ScrollArea, Table } from '@mantine/core';
import { HistoryRunRow } from '~/components/history/HistoryRunRow.js';
import { SortableHeader, type SortDir } from '~/components/table/SortableHeader.js';
import { useT } from '~/i18n/index.js';

export type HistorySortField = 'startedAt' | 'endedAt' | 'project' | 'tool' | 'status';

export interface HistoryRunsTableProps {
  paginatedData: RunRecord[];
  tools: readonly ToolView[];
  sharedProject: string | null;
  sharedType: string | null;
  advancedMode: boolean;
  sortField: HistorySortField;
  sortDir: SortDir;
  handleSort: (field: HistorySortField) => void;
  compareSel: Set<string>;
  toggleCompare: (id: string) => void;
  handleRerun: (run: RunRecord) => void;
  onRerunFailed: (run: RunRecord) => void;
  handleCopyCommand: (command: string) => void;
  handleViewLog: (run: RunRecord) => void;
}

export function HistoryRunsTable({
  paginatedData,
  tools,
  sharedProject,
  sharedType,
  advancedMode,
  sortField,
  sortDir,
  handleSort,
  compareSel,
  toggleCompare,
  handleRerun,
  onRerunFailed,
  handleCopyCommand,
  handleViewLog,
}: HistoryRunsTableProps) {
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
      {/* Bounded ScrollArea → table scrolls inside the card (sticky header)
          instead of growing the page; pagination below stays visible. */}
      <ScrollArea type="auto" style={{ flex: 1, minHeight: 0 }}>
        <Table
          striped
          highlightOnHover
          verticalSpacing="xs"
          stickyHeader
          miw={advancedMode ? 1300 : 1160}
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={40} />
              <Table.Th w={1}>
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
              <Table.Th>{t('table.environment')}</Table.Th>
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
              <HistoryRunRow
                key={r.id}
                r={r}
                tools={tools}
                sharedProject={sharedProject}
                sharedType={sharedType}
                advancedMode={advancedMode}
                compareChecked={compareSel.has(r.id)}
                toggleCompare={toggleCompare}
                handleRerun={handleRerun}
                onRerunFailed={onRerunFailed}
                handleCopyCommand={handleCopyCommand}
                handleViewLog={handleViewLog}
              />
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>
    </Paper>
  );
}
