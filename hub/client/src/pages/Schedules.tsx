import type { CustomCommand } from '@hub/shared';
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Paper,
  Select,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CronExpressionParser } from 'cron-parser';
import cronstrue from 'cronstrue';
import dayjs from 'dayjs';
import { useState } from 'react';
import {
  TbAlertTriangle,
  TbCalendar,
  TbCalendarPlus,
  TbClock,
  TbList,
  TbPencil,
  TbTerminal2,
  TbTool,
  TbTrash,
} from 'react-icons/tb';
import { api } from '~/api/client.js';
import { confirmDialog } from '~/components/confirmDialog.js';
import { EmptyState } from '~/components/EmptyState.js';
import { InlineAlert } from '~/components/InlineAlert.js';
import { PageHeader } from '~/components/PageHeader.js';
import { ScheduleCalendar } from '~/components/ScheduleCalendar.js';
import { ListSkeleton } from '~/components/Skeletons.js';
import { type Schedule, ScheduleForm } from '~/components/schedule-form/ScheduleForm.js';
import { toast } from '~/components/Toast.js';
import { useToolOptions } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';
import { usePreferences } from '~/stores/hub.js';
import { getStatusColor } from '~/utils/run-status.js';

/**
 * Human-readable one-liner for a custom schedule's command, for the row tooltip.
 * Mirrors what the server will actually run (`buildCustomCommand`) closely enough
 * to be useful, without importing server code into the client.
 */
function buildCommandPreview(command: CustomCommand): string {
  const parts = [command.script, command.args].filter(Boolean).join(' ');
  return command.cwd ? `${parts}\n(cwd: ${command.cwd})` : parts;
}

function describeNextRun(cronExpr: string): string {
  try {
    const interval = CronExpressionParser.parse(cronExpr);
    const next = interval.next().toDate();
    const diffMs = next.getTime() - Date.now();
    const diffMin = Math.round(diffMs / 60000);
    if (diffMin < 1) return 'in <1 min';
    if (diffMin < 60) return `in ${diffMin} min`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `in ${diffHr}h ${diffMin % 60}m`;
    const diffDays = Math.round(diffHr / 24);
    return `in ${diffDays}d (${dayjs(next).format('DD MMM YYYY HH:mm')})`;
  } catch {
    return 'invalid cron';
  }
}

function humanizeCron(cronExpr: string): string {
  try {
    return cronstrue.toString(cronExpr, { use24HourTimeFormat: false });
  } catch {
    return 'invalid cron';
  }
}

export function SchedulesPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [createOpen, { open: openCreate, close: closeCreate }] = useDisclosure(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);

  /**
   * Which KIND of schedule the list shows. A custom schedule carries `command`;
   * a tool schedule does not. Tools is the default because it is the common case
   * and the one that existed before custom schedules.
   */
  const [kind, setKind] = useState<'tool' | 'custom'>('tool');
  const advancedMode = usePreferences((s) => s.advancedMode);

  // Filters
  const [filterTool, setFilterTool] = useState<string | null>(null);
  const [filterProject, setFilterProject] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [groupBy, setGroupBy] = useState<'none' | 'tool' | 'project'>('none');
  const toolOptions = useToolOptions();

  const schedules = useQuery<Schedule[]>({
    queryKey: ['schedules'],
    queryFn: () => api.get('/api/schedules'),
  });

  const toggleMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/schedules/${id}/toggle`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['schedules'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/schedules/${id}`),
    onSuccess: () => {
      toast.success(t('schedule.deleted'));
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
    },
  });

  async function handleDelete(id: string) {
    const ok = await confirmDialog({
      title: t('schedule.deleteTitle'),
      message: t('schedule.deleteConfirm'),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (ok) deleteMutation.mutate(id);
  }

  const all = schedules.data ?? [];
  const toolCount = all.filter((s) => s.command === undefined).length;
  const customCount = all.length - toolCount;

  const filtered = all.filter((s) => {
    if (kind === 'custom' ? s.command === undefined : s.command !== undefined) return false;
    // The tool/project filters only mean something for a tool schedule.
    if (kind === 'tool') {
      if (filterTool && s.config.tool !== filterTool) return false;
      if (filterProject && !s.config.project.toLowerCase().includes(filterProject.toLowerCase()))
        return false;
    }
    if (filterStatus === 'enabled' && !s.enabled) return false;
    if (filterStatus === 'disabled' && s.enabled) return false;
    return true;
  });

  function getGroups(): { label: string; items: Schedule[] }[] {
    if (groupBy === 'none') return [{ label: '', items: filtered }];
    const grouped: Record<string, Schedule[]> = {};
    for (const s of filtered) {
      const key = groupBy === 'tool' ? s.config.tool : s.config.project;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(s);
    }
    return Object.entries(grouped)
      .map(([label, items]) => ({ label, items }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  const groups = getGroups();

  return (
    <Stack gap="md">
      <PageHeader
        title={t('schedules.title')}
        description={t('nav.schedules.desc')}
        actions={
          <Button leftSection={<TbCalendarPlus size={14} />} onClick={openCreate} size="xs">
            {t('schedules.newSchedule')}
          </Button>
        }
      />

      {schedules.data && schedules.data.length > 0 && (
        <Paper p="sm" withBorder>
          <Group gap="sm" wrap="wrap">
            <Select
              size="xs"
              placeholder={t('filter.allTools')}
              value={filterTool}
              onChange={setFilterTool}
              data={toolOptions}
              clearable
              w={140}
            />
            <TextInput
              size="xs"
              placeholder={t('filter.filterProject')}
              value={filterProject}
              onChange={(e) => setFilterProject(e.currentTarget.value)}
              w={160}
            />
            <Select
              size="xs"
              value={filterStatus}
              onChange={(v) => setFilterStatus((v as 'all' | 'enabled' | 'disabled') ?? 'all')}
              data={[
                { value: 'all', label: t('common.all') },
                { value: 'enabled', label: t('common.enabled') },
                { value: 'disabled', label: t('common.disabled') },
              ]}
              allowDeselect={false}
              w={110}
            />
            <Select
              size="xs"
              placeholder={t('filter.groupBy')}
              value={groupBy}
              onChange={(v) => setGroupBy((v as 'none' | 'tool' | 'project') ?? 'none')}
              data={[
                { value: 'none', label: t('filter.noGrouping') },
                { value: 'tool', label: t('filter.groupByTool') },
                { value: 'project', label: t('filter.groupByProject') },
              ]}
              allowDeselect={false}
              w={150}
            />
            {filtered.length !== (schedules.data?.length ?? 0) && (
              <Text size="xs" c="dimmed">
                {t('filter.showing')} {filtered.length} {t('filter.of')} {schedules.data?.length}
              </Text>
            )}
          </Group>
        </Paper>
      )}

      {schedules.isLoading && <ListSkeleton rows={4} />}

      {schedules.isError && (
        <InlineAlert
          color="red"
          icon={<TbAlertTriangle size={14} color="var(--mantine-color-red-6)" />}
          message={t('common.loadFailed')}
          action={
            <Button
              size="compact-xs"
              variant="light"
              color="red"
              onClick={() => schedules.refetch()}
            >
              {t('common.retry')}
            </Button>
          }
        />
      )}

      {schedules.data && schedules.data.length === 0 && (
        <EmptyState
          icon={<TbCalendar size={48} color="var(--mantine-color-dimmed)" />}
          description={t('schedules.noSchedules')}
          action={
            <Button size="xs" leftSection={<TbCalendarPlus size={14} />} onClick={openCreate}>
              {t('schedules.newSchedule')}
            </Button>
          }
        />
      )}

      {schedules.data && schedules.data.length > 0 && (
        <Tabs defaultValue="list" keepMounted={false}>
          <Tabs.List>
            <Tabs.Tab value="list" leftSection={<TbList size={14} />}>
              {t('schedules.list')}
            </Tabs.Tab>
            <Tabs.Tab value="calendar" leftSection={<TbCalendar size={14} />}>
              {t('schedules.calendar')}
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="list" pt="md">
            {/* Sub-tabs used as a CONTROL only (no panels): both kinds render the
                same rows below, so there is nothing to duplicate. */}
            <Tabs value={kind} onChange={(v) => setKind(v === 'custom' ? 'custom' : 'tool')}>
              <Tabs.List>
                <Tabs.Tab value="tool" leftSection={<TbTool size={14} />}>
                  {t('schedules.kindTools')}
                  <Badge size="xs" variant="light" color="gray" ml={6}>
                    {toolCount}
                  </Badge>
                </Tabs.Tab>
                {advancedMode && (
                  <Tabs.Tab value="custom" leftSection={<TbTerminal2 size={14} />}>
                    {t('schedules.kindCustom')}
                    <Badge size="xs" variant="light" color="gray" ml={6}>
                      {customCount}
                    </Badge>
                  </Tabs.Tab>
                )}
              </Tabs.List>
            </Tabs>

            {filtered.length === 0 && (
              <EmptyState
                icon={
                  kind === 'custom' ? (
                    <TbTerminal2 size={40} color="var(--mantine-color-dimmed)" />
                  ) : (
                    <TbTool size={40} color="var(--mantine-color-dimmed)" />
                  )
                }
                description={
                  kind === 'custom' ? t('schedules.noCustom') : t('schedules.noToolSchedules')
                }
                action={
                  <Button size="xs" leftSection={<TbCalendarPlus size={14} />} onClick={openCreate}>
                    {t('schedules.newSchedule')}
                  </Button>
                }
              />
            )}

            <Stack gap="md" pt="md">
              {groups.map((group) => (
                <Stack key={group.label || '__all'} gap="xs">
                  {group.label && (
                    <Group gap="xs">
                      <Text size="xs" fw={700} c="dimmed" tt="uppercase">
                        {group.label}
                      </Text>
                      <Badge size="xs" variant="light" color="gray">
                        {group.items.length}
                      </Badge>
                    </Group>
                  )}
                  {group.items.map((s) => (
                    <Paper key={s.id} p="md" withBorder style={{ opacity: s.enabled ? 1 : 0.65 }}>
                      <Group justify="space-between" wrap="wrap" gap="md">
                        <Group gap="md" wrap="nowrap">
                          <Switch
                            checked={s.enabled}
                            onChange={() => toggleMutation.mutate(s.id)}
                            size="md"
                            color="green"
                          />
                          <Stack gap={2}>
                            <Text size="sm" fw={500}>
                              {s.name}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {humanizeCron(s.cron)}{' '}
                              <Text span ff="monospace" c="dimmed.6">
                                ({s.cron})
                              </Text>
                            </Text>
                            {s.enabled && (
                              <Group gap={4}>
                                <TbClock size={12} color="var(--mantine-color-blue-6)" />
                                <Text size="xs" c="blue">
                                  {t('schedule.nextRun')} {describeNextRun(s.cron)}
                                </Text>
                              </Group>
                            )}
                          </Stack>
                        </Group>
                        <Group gap="xs" wrap="wrap">
                          {s.command ? (
                            <Tooltip label={buildCommandPreview(s.command)} multiline w={360}>
                              <Badge
                                variant="light"
                                color="grape"
                                maw={220}
                                leftSection={<TbTerminal2 size={11} />}
                                style={{ fontFamily: 'var(--mantine-font-family-monospace)' }}
                              >
                                {s.command.script}
                              </Badge>
                            </Tooltip>
                          ) : (
                            <Tooltip label={`${s.config.tool}/${s.config.project}`}>
                              <Badge variant="light" color="gray" maw={180}>
                                {s.config.tool}/{s.config.project}
                              </Badge>
                            </Tooltip>
                          )}
                          {s.config.tag && (
                            <Tooltip label={s.config.tag} multiline w={400}>
                              <Badge variant="light" color="blue" maw={140}>
                                {t('schedule.tagged')}
                              </Badge>
                            </Tooltip>
                          )}
                          {s.lastRunAt && (
                            <Tooltip
                              label={`${t('schedule.lastRunPrefix')} ${new Date(s.lastRunAt).toLocaleString()}`}
                            >
                              <Badge variant="light" color={getStatusColor(s.lastStatus ?? '')}>
                                {t('schedule.lastPrefix')} {new Date(s.lastRunAt).toLocaleString()}
                              </Badge>
                            </Tooltip>
                          )}
                          <ActionIcon
                            variant="subtle"
                            color="blue"
                            onClick={() => setEditingSchedule(s)}
                            aria-label={t('schedule.editAria')}
                          >
                            <TbPencil size={16} />
                          </ActionIcon>
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            onClick={() => handleDelete(s.id)}
                            aria-label={t('schedule.deleteAria')}
                          >
                            <TbTrash size={16} />
                          </ActionIcon>
                        </Group>
                      </Group>
                    </Paper>
                  ))}
                </Stack>
              ))}
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="calendar" pt="md">
            <ScheduleCalendar schedules={schedules.data} />
          </Tabs.Panel>
        </Tabs>
      )}

      <ScheduleForm
        mode="create"
        opened={createOpen}
        onClose={closeCreate}
        onSuccess={() => {
          closeCreate();
          queryClient.invalidateQueries({ queryKey: ['schedules'] });
        }}
      />

      <ScheduleForm
        mode="edit"
        schedule={editingSchedule}
        onClose={() => setEditingSchedule(null)}
        onSuccess={() => {
          setEditingSchedule(null);
          queryClient.invalidateQueries({ queryKey: ['schedules'] });
        }}
      />
    </Stack>
  );
}
