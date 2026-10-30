import type { RunStatus, ToolId } from '@hub/shared';
import { Badge, Button, Group, Paper, Stack, Text, TextInput } from '@mantine/core';
import { DatePickerInput, type DateValue } from '@mantine/dates';
import { TbCalendar } from 'react-icons/tb';
import { useT } from '~/i18n/index.js';
import { getStatusColor, getStatusIcon, statusLabelKey } from '~/utils/run-status.js';
import { toggleInSet } from '~/utils/toggle-in-set.js';

const ALL_STATUSES: RunStatus[] = ['passed', 'failed'];

export interface HistoryFilterPanelProps {
  activeFilterCount: number;
  clearFilters: () => void;
  dateRange: [DateValue, DateValue];
  setDateRange: (value: [DateValue, DateValue]) => void;
  filterProject: string;
  handleFilterChange: (value: string) => void;
  toolIds: ToolId[];
  selectedTools: Set<ToolId>;
  setSelectedTools: (value: Set<ToolId>) => void;
  availableTypes: string[];
  selectedTypes: Set<string>;
  setSelectedTypes: (value: Set<string>) => void;
  selectedStatuses: Set<RunStatus>;
  setSelectedStatuses: (value: Set<RunStatus>) => void;
  setCurrentPage: (page: number) => void;
}

export function HistoryFilterPanel({
  activeFilterCount,
  clearFilters,
  dateRange,
  setDateRange,
  filterProject,
  handleFilterChange,
  toolIds,
  selectedTools,
  setSelectedTools,
  availableTypes,
  selectedTypes,
  setSelectedTypes,
  selectedStatuses,
  setSelectedStatuses,
  setCurrentPage,
}: HistoryFilterPanelProps) {
  const t = useT();
  return (
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
                  {t(statusLabelKey(s))}
                </Badge>
              ))}
            </Group>
          </Stack>
        </Group>
      </Stack>
    </Paper>
  );
}
