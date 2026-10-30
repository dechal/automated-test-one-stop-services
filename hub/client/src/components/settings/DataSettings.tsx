import {
  Badge,
  Button,
  Collapse,
  Divider,
  Group,
  NumberInput,
  Paper,
  ScrollArea,
  SimpleGrid,
  Skeleton,
  Stack,
  Switch,
  Table,
  Text,
  Title,
} from '@mantine/core';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import type { Dispatch, SetStateAction } from 'react';
import { TbChevronRight, TbRefresh, TbTrash } from 'react-icons/tb';
import { confirmDialog } from '~/components/confirmDialog';
import { ImportExportPanel } from '~/components/ImportExportPanel';
import { toast } from '~/components/Toast';
import type { useResyncWorkspace } from '~/hooks/useTools.js';
import { useT } from '~/i18n';
import { usePreferences } from '~/stores/hub.js';
import { formatShort } from '~/utils/datetime.js';

export interface RetentionSettings {
  retentionDays: number;
  autoCleanup: boolean;
}

export interface CleanupHistoryEntry {
  timestamp: string;
  deleted: number;
  total: number;
  retentionDays: number;
  trigger: 'manual' | 'auto';
}

export interface DataSettingsProps {
  retentionQ: UseQueryResult<RetentionSettings>;
  cleanupDays: number | '';
  setCleanupDays: (value: number | '') => void;
  autoCleanup: boolean;
  setAutoCleanup: (value: boolean) => void;
  retentionMutation: UseMutationResult<unknown, Error, RetentionSettings>;
  cleanupMutation: UseMutationResult<{ deleted: number; total: number }, Error, void>;
  cleanupHistoryQ: UseQueryResult<CleanupHistoryEntry[]>;
  historyOpen: boolean;
  setHistoryOpen: Dispatch<SetStateAction<boolean>>;
  resync: ReturnType<typeof useResyncWorkspace>;
}

export function DataSettings({
  retentionQ,
  cleanupDays,
  setCleanupDays,
  autoCleanup,
  setAutoCleanup,
  retentionMutation,
  cleanupMutation,
  cleanupHistoryQ,
  historyOpen,
  setHistoryOpen,
  resync,
}: DataSettingsProps) {
  const t = useT();
  const showOnboarding = usePreferences((s) => s.showOnboarding);
  const toggleOnboarding = usePreferences((s) => s.toggleOnboarding);
  return (
    <>
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        {/* Output Retention */}
        <Paper p="md" withBorder>
          <Title order={2} size="h5" mb="sm">
            {t('settings.outputRetention')}
          </Title>
          <Stack gap="sm">
            <Group justify="space-between">
              <Stack gap={2}>
                <Text size="sm">{t('settings.retentionPeriod')}</Text>
                <Text size="xs" c="dimmed">
                  {t('settings.retentionPeriodDesc')}
                </Text>
              </Stack>
              {retentionQ.isLoading ? (
                <Skeleton height={30} width={100} radius="sm" aria-hidden />
              ) : (
                <NumberInput
                  size="xs"
                  w={100}
                  min={1}
                  max={365}
                  value={cleanupDays}
                  onChange={(v) => setCleanupDays(typeof v === 'number' ? v : '')}
                  suffix={t('settings.daysSuffix')}
                />
              )}
            </Group>

            <Group justify="space-between">
              <Stack gap={2}>
                <Text size="sm">{t('settings.autoCleanup')}</Text>
                <Text size="xs" c="dimmed">
                  {t('settings.autoCleanupDesc')}
                </Text>
              </Stack>
              <Switch
                checked={autoCleanup}
                onChange={(e) => setAutoCleanup(e.currentTarget.checked)}
                size="md"
              />
            </Group>

            <Group gap="xs">
              <Button
                size="xs"
                onClick={() => {
                  retentionMutation.mutate({
                    retentionDays: typeof cleanupDays === 'number' ? cleanupDays : 30,
                    autoCleanup,
                  });
                }}
                loading={retentionMutation.isPending}
              >
                {t('settings.saveSettings')}
              </Button>
              <Button
                size="xs"
                color="red"
                variant="subtle"
                leftSection={<TbTrash size={12} />}
                onClick={() => cleanupMutation.mutate()}
                loading={cleanupMutation.isPending}
                disabled={!cleanupDays}
              >
                {t('settings.cleanupNow')}
              </Button>
            </Group>

            {/* Cleanup History */}
            <Divider />
            <Group gap="xs" style={{ cursor: 'pointer' }} onClick={() => setHistoryOpen((v) => !v)}>
              <TbChevronRight
                size={12}
                style={{
                  transform: historyOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                  transition: 'transform 150ms',
                }}
              />
              <Text size="xs" fw={600} c="dimmed">
                {t('settings.cleanupHistory')} ({cleanupHistoryQ.data?.length ?? 0})
              </Text>
            </Group>
            <Collapse expanded={historyOpen}>
              {cleanupHistoryQ.data && cleanupHistoryQ.data.length > 0 ? (
                <ScrollArea.Autosize mah="25vh">
                  <Table striped highlightOnHover verticalSpacing={4}>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>
                          <Text size="xs">{t('settings.colWhen')}</Text>
                        </Table.Th>
                        <Table.Th>
                          <Text size="xs">{t('settings.colDeleted')}</Text>
                        </Table.Th>
                        <Table.Th>
                          <Text size="xs">{t('settings.colRetention')}</Text>
                        </Table.Th>
                        <Table.Th>
                          <Text size="xs">{t('settings.colTrigger')}</Text>
                        </Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {cleanupHistoryQ.data.map((h) => (
                        <Table.Tr key={h.timestamp}>
                          <Table.Td>
                            <Text size="xs">{formatShort(h.timestamp)}</Text>
                          </Table.Td>
                          <Table.Td>
                            <Text size="xs" fw={500} c={h.deleted > 0 ? 'red' : 'dimmed'}>
                              {h.deleted}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <Text size="xs">{h.retentionDays}d</Text>
                          </Table.Td>
                          <Table.Td>
                            <Badge
                              size="xs"
                              color={h.trigger === 'auto' ? 'blue' : 'gray'}
                              variant="light"
                            >
                              {h.trigger}
                            </Badge>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </ScrollArea.Autosize>
              ) : (
                <Text size="xs" c="dimmed">
                  {t('settings.noCleanup')}
                </Text>
              )}
            </Collapse>
          </Stack>
        </Paper>

        {/* Data */}
        <Paper p="md" withBorder>
          <Title order={2} size="h5" mb="sm">
            {t('settings.dataStorage')}
          </Title>
          <Stack gap="sm">
            <Group justify="space-between">
              <Stack gap={2}>
                <Text size="sm">{t('settings.showOnboarding')}</Text>
                <Text size="xs" c="dimmed">
                  {t('settings.showOnboardingDesc')}
                </Text>
              </Stack>
              <Switch checked={showOnboarding} onChange={() => toggleOnboarding()} size="md" />
            </Group>

            <Divider />

            {/* Projects/tools added outside the Hub (git clone, file copy) are
                invisible until the workspace is re-scanned. Exposing it here
                saves a terminal trip. */}
            <Group justify="space-between">
              <Stack gap={2}>
                <Text size="sm">{t('settings.resync')}</Text>
                <Text size="xs" c="dimmed">
                  {t('settings.resyncDesc')}
                </Text>
              </Stack>
              <Button
                size="xs"
                variant="light"
                leftSection={<TbRefresh size={14} />}
                loading={resync.isPending}
                onClick={() =>
                  resync.mutate(undefined, {
                    onSuccess: () => toast.success(t('settings.resyncDone')),
                  })
                }
              >
                {t('settings.resyncAction')}
              </Button>
            </Group>

            <Divider />

            <Group justify="space-between">
              <Stack gap={2}>
                <Text size="sm">{t('settings.resetPrefs')}</Text>
                <Text size="xs" c="dimmed">
                  {t('settings.resetPrefsDesc')}
                </Text>
              </Stack>
              <Button
                size="xs"
                color="red"
                variant="subtle"
                onClick={async () => {
                  const ok = await confirmDialog({
                    title: t('settings.resetTitle'),
                    message: t('settings.resetConfirm'),
                    confirmLabel: t('settings.reset'),
                    danger: true,
                  });
                  if (!ok) return;
                  localStorage.removeItem('hub-preferences');
                  localStorage.removeItem('hub-notification-sound');
                  localStorage.removeItem('hub-desktop-notification');
                  window.location.reload();
                }}
              >
                {t('settings.resetAll')}
              </Button>
            </Group>
          </Stack>
        </Paper>
      </SimpleGrid>

      {/* Import / Export */}
      <ImportExportPanel />
    </>
  );
}
