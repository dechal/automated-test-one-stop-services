import type { ToolId } from '@hub/shared';
import {
  Anchor,
  Badge,
  Button,
  Collapse,
  Divider,
  Flex,
  Group,
  Modal,
  NavLink,
  NumberInput,
  Paper,
  ScrollArea,
  Select,
  SimpleGrid,
  Skeleton,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import {
  TbBell,
  TbBrandDocker,
  TbChevronRight,
  TbDatabase,
  TbInfoCircle,
  TbMoonStars,
  TbPlayerPlay,
  TbQrcode,
  TbRefresh,
  TbServer,
  TbSettings,
  TbSun,
  TbTrash,
  TbUser,
} from 'react-icons/tb';
import { api } from '~/api/client';
import { waitForHealth } from '~/api/health.js';
import { qCleanupHistory, qConcurrency, qRetention, queryRoots } from '~/api/queries.js';
import { confirmDialog } from '~/components/confirmDialog';
import { ImportExportPanel } from '~/components/ImportExportPanel';
import { PageHeader } from '~/components/PageHeader.js';
import { UsageLoggingSetup } from '~/components/projects/UsageLoggingSetup.js';
import { toast } from '~/components/Toast';
import {
  requestDesktopPermission,
  useDesktopNotification,
} from '~/hooks/useDesktopNotification.js';
import { useHubUser, useSaveHubUser } from '~/hooks/useHubUser.js';
import { useNotificationSound } from '~/hooks/useNotificationSound.js';
import { useResyncWorkspace, useToolOptions } from '~/hooks/useTools.js';
import { type Locale, type TranslationKey, useI18nStore, useT } from '~/i18n';
import { DockerServicesBody } from '~/pages/DockerServices.js';
import { WebhooksBody } from '~/pages/Webhooks.js';
import { settingsRoute } from '~/router';
import { usePreferences } from '~/stores/hub.js';
import { formatShort } from '~/utils/datetime.js';

interface UpdateStatusResponse {
  running: boolean;
  stage: 'idle' | 'shared' | 'client' | 'server' | 'restarting' | 'done';
  error?: string;
  finishedAt?: string;
}

export type SettingsCategory =
  | 'general'
  | 'execution'
  | 'notifications'
  | 'data'
  | 'system'
  | 'about';

const SIDEBAR_WIDTH = 220;

const CATEGORIES: { id: SettingsCategory; labelKey: TranslationKey; icon: ReactNode }[] = [
  { id: 'general', labelKey: 'settings.sectionGeneral', icon: <TbSettings size={18} /> },
  { id: 'execution', labelKey: 'settings.categoryExecution', icon: <TbPlayerPlay size={18} /> },
  { id: 'notifications', labelKey: 'settings.sectionNotifications', icon: <TbBell size={18} /> },
  { id: 'data', labelKey: 'settings.sectionData', icon: <TbDatabase size={18} /> },
  { id: 'system', labelKey: 'settings.categorySystem', icon: <TbServer size={18} /> },
  { id: 'about', labelKey: 'settings.categoryAbout', icon: <TbInfoCircle size={18} /> },
];

/**
 * Poll /api/system/update/status until the server reports the build is done
 * (or has errored). Resolves with the terminal status object. `labels` maps
 * each stage to an already-translated string so status text is localized.
 */
async function pollUpdateStatus(
  setStage: (s: string) => void,
  timeoutMs: number,
  labels: Record<UpdateStatusResponse['stage'], string>,
): Promise<UpdateStatusResponse> {
  const start = Date.now();
  let last: UpdateStatusResponse = { running: true, stage: 'shared' };
  while (Date.now() - start < timeoutMs) {
    try {
      last = await api.get<UpdateStatusResponse>('/api/system/update/status');
      setStage(labels[last.stage] || '');
      if (!last.running) return last;
      // While restarting, the next poll may fail because the server is gone.
      // The outer flow handles that via waitForHealth.
      if (last.stage === 'restarting') return last;
    } catch {
      // server bouncing — caller will fall back to waitForHealth
      return last;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
}

export function SettingsPage() {
  const t = useT();
  const search = settingsRoute.useSearch();
  const [category, setCategory] = useState<SettingsCategory>(search.cat ?? 'general');
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const { locale, setLocale } = useI18nStore();
  const lastTool = usePreferences((s) => s.lastTool);
  const defaultMode = usePreferences((s) => s.defaultMode);
  const defaultHeadless = usePreferences((s) => s.defaultHeadless);
  const showOnboarding = usePreferences((s) => s.showOnboarding);
  const advancedMode = usePreferences((s) => s.advancedMode);
  const setAdvancedMode = usePreferences((s) => s.setAdvancedMode);
  const setLastTool = usePreferences((s) => s.setLastTool);
  const setDefaultMode = usePreferences((s) => s.setDefaultMode);
  const setDefaultHeadless = usePreferences((s) => s.setDefaultHeadless);
  const toggleOnboarding = usePreferences((s) => s.toggleOnboarding);
  const queryClient = useQueryClient();
  const resync = useResyncWorkspace();
  const toolOptions = useToolOptions();
  const [qrOpened, { open: openQr, close: closeQr }] = useDisclosure(false);
  const { enabled: soundEnabled, toggle: toggleSound } = useNotificationSound();
  const desktopEnabled = useDesktopNotification((s) => s.enabled);
  const setDesktopEnabled = useDesktopNotification((s) => s.setEnabled);

  // Enabling desktop notifications requires an OS permission grant; request it
  // on enable and revert the toggle (with a hint) if the browser blocks it.
  const handleToggleDesktop = async (checked: boolean) => {
    if (!checked) {
      setDesktopEnabled(false);
      return;
    }
    const permission = await requestDesktopPermission();
    if (permission === 'granted') {
      setDesktopEnabled(true);
    } else {
      setDesktopEnabled(false);
      toast.error(t('settings.desktopPermissionDenied'));
    }
  };

  // Identity — the name stamped into test-case "Edited By". Seeded from the
  // server once loaded so the field shows the current name, not a blank.
  const hubUser = useHubUser();
  const saveUser = useSaveHubUser();
  const [nameInput, setNameInput] = useState('');
  useEffect(() => {
    if (hubUser.user) setNameInput(hubUser.user.name);
  }, [hubUser.user]);

  // Concurrency
  const concurrencyQ = useQuery(qConcurrency());
  const [concurrencyInput, setConcurrencyInput] = useState<number | ''>(
    concurrencyQ.data?.maxConcurrency ?? 2,
  );
  const concurrencyMutation = useMutation({
    mutationFn: (n: number) => api.put('/api/runs/concurrency', { maxConcurrency: n }),
    onSuccess: () => {
      toast.success(t('settings.concurrencyUpdated'));
      queryClient.invalidateQueries({ queryKey: [queryRoots.concurrency] });
    },
    onError: () => toast.error(t('settings.concurrencyFailed')),
  });

  // Sync the input once the server value loads. The useState above lazy-seeds
  // 2 while the query is still pending; without this a server value other than
  // 2 would render as 2 and the Save guard (input === data) would let a
  // careless save silently downgrade concurrency. Mirrors the retention sync.
  useEffect(() => {
    if (concurrencyQ.data) setConcurrencyInput(concurrencyQ.data.maxConcurrency);
  }, [concurrencyQ.data]);

  // Cleanup — load from server
  const retentionQ = useQuery(qRetention());
  const [cleanupDays, setCleanupDays] = useState<number | ''>(30);
  const [autoCleanup, setAutoCleanup] = useState(false);

  // Sync local state once server data is loaded. Using useEffect avoids
  // setState-in-render warnings and the previous edge case where servers
  // returning the default 30/false would never sync.
  useEffect(() => {
    if (retentionQ.data) {
      setCleanupDays(retentionQ.data.retentionDays);
      setAutoCleanup(retentionQ.data.autoCleanup);
    }
  }, [retentionQ.data]);

  const retentionMutation = useMutation({
    mutationFn: (settings: { retentionDays: number; autoCleanup: boolean }) =>
      api.put('/api/system/retention', settings),
    onSuccess: () => {
      toast.success(t('settings.retentionSaved'));
      queryClient.invalidateQueries({ queryKey: [queryRoots.retention] });
    },
    onError: () => toast.error(t('settings.retentionFailed')),
  });

  const cleanupMutation = useMutation<{ deleted: number; total: number }>({
    mutationFn: () => api.post('/api/system/cleanup', { olderThanDays: cleanupDays || 30 }),
    onSuccess: (data) => {
      toast.success(
        `${t('settings.cleanupDeletedPrefix')} ${data.deleted} — ${t('settings.cleanupOlderThan')} ${cleanupDays}${t('settings.daysSuffix')}`,
      );
      queryClient.invalidateQueries({ queryKey: ['reports'] });
      queryClient.invalidateQueries({ queryKey: [queryRoots.cleanupHistory] });
    },
    onError: () => toast.error(t('settings.cleanupFailed')),
  });

  // Cleanup history
  const cleanupHistoryQ = useQuery(qCleanupHistory());
  const [historyOpen, setHistoryOpen] = useState(false);

  // System update state
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);

  const runUpdate = async () => {
    setIsUpdating(true);
    setUpdateStatus(t('settings.startingBuild'));
    try {
      await api.post<{ ok: boolean; message: string }>('/api/system/update', {});

      // Server now runs the build in the background and returns 202 immediately.
      // Poll the status endpoint to surface real stage transitions to the user.
      const stageLabels: Record<UpdateStatusResponse['stage'], string> = {
        idle: '',
        shared: t('settings.buildingShared'),
        client: t('settings.buildingClient'),
        server: t('settings.buildingServer'),
        restarting: t('settings.restartingHub'),
        done: t('settings.updateDoneStatus'),
      };
      const final = await pollUpdateStatus(setUpdateStatus, 5 * 60_000, stageLabels);

      if (final.error) {
        setUpdateStatus(null);
        setIsUpdating(false);
        const finalError = final.error;
        toast.error(t('settings.updateFailed').replace('{error}', () => finalError));
        return;
      }

      setUpdateStatus(t('settings.buildDoneRestarting'));

      // Wait until /api/health responds again (server has restarted).
      const healthOk = await waitForHealth(60_000);
      if (!healthOk) {
        setUpdateStatus(null);
        setIsUpdating(false);
        toast.error(t('settings.serverTimeout'));
        return;
      }

      setUpdateStatus(t('settings.updateDoneStatus'));
      toast.success(t('settings.updateDoneToast'));
      const reload = await confirmDialog({
        title: t('settings.reloadTitle'),
        message: t('settings.reloadQuestion'),
        confirmLabel: t('settings.reloadLabel'),
        cancelLabel: t('common.later'),
        isShowClose: false,
        isShowCancel: false,
        isCloseOnClickOutside: false,
        isCloseOnEscape: false,
      });
      if (reload) {
        window.location.reload();
      } else {
        setIsUpdating(false);
      }
    } catch (err) {
      setUpdateStatus(null);
      setIsUpdating(false);
      const error = err as Error & { stage?: string };
      const stage = error.stage ? ` (${error.stage})` : '';
      const message = error.message || t('settings.unknownError');
      toast.error(
        t('settings.updateHubFailed')
          .replace('{stage}', () => stage)
          .replace('{error}', () => message),
      );
    }
  };

  return (
    <Stack gap="md">
      <PageHeader title={t('nav.settings')} description={t('nav.settings.desc')} />

      <Flex gap="lg" align="flex-start">
        <Stack gap={4} w={SIDEBAR_WIDTH} style={{ flexShrink: 0 }}>
          {CATEGORIES.map((c) => (
            <NavLink
              key={c.id}
              active={category === c.id}
              label={t(c.labelKey)}
              leftSection={c.icon}
              variant="filled"
              onClick={() => setCategory(c.id)}
            />
          ))}
        </Stack>

        <Stack gap="md" style={{ flex: 1, minWidth: 0 }}>
          {category === 'general' && (
            <>
              {/* Two cards, not three. Theme and language are the same concern (how the
          Hub presents itself) and each held a single row, so in a 3-up grid they
          were stretched to the height of the 2-row Notifications card and carried
          ~100px of empty space each. Merged, both columns hold two rows and the
          row has no dead space. */}
              <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
                {/* Display — theme + language */}
                <Paper p="md" withBorder>
                  <Title order={2} size="h5" mb="sm">
                    {t('settings.appearance')}
                  </Title>
                  <Stack gap="sm">
                    <Group justify="space-between">
                      <Stack gap={2}>
                        <Text size="sm">{t('settings.colorScheme')}</Text>
                        <Text size="xs" c="dimmed">
                          {t('settings.colorSchemeDesc')}
                        </Text>
                      </Stack>
                      <Select
                        size="xs"
                        w={140}
                        value={colorScheme}
                        onChange={(v) => v && setColorScheme(v as 'light' | 'dark' | 'auto')}
                        data={[
                          { value: 'dark', label: t('settings.dark') },
                          { value: 'light', label: t('settings.light') },
                          { value: 'auto', label: t('settings.system') },
                        ]}
                        allowDeselect={false}
                        leftSection={
                          colorScheme === 'dark' ? <TbMoonStars size={14} /> : <TbSun size={14} />
                        }
                      />
                    </Group>
                    <Group justify="space-between">
                      <Stack gap={2}>
                        <Text size="sm">{t('settings.interfaceLanguage')}</Text>
                        <Text size="xs" c="dimmed">
                          {t('settings.interfaceLanguageDesc')}
                        </Text>
                      </Stack>
                      <Select
                        size="xs"
                        w={140}
                        value={locale}
                        onChange={(v) => v && setLocale(v as Locale)}
                        data={[
                          { value: 'en', label: 'English' },
                          { value: 'th', label: 'ไทย' },
                        ]}
                        allowDeselect={false}
                      />
                    </Group>
                  </Stack>
                </Paper>

                <Paper p="md" withBorder>
                  <Group justify="space-between" mb="sm" wrap="nowrap" align="flex-start">
                    <Title order={2} size="h5">
                      {t('common.advancedMode')}
                    </Title>
                    <Switch
                      size="md"
                      checked={advancedMode}
                      onChange={(e) => setAdvancedMode(e.currentTarget.checked)}
                      aria-label={t('common.advancedMode')}
                    />
                  </Group>
                  <Stack gap="xs">
                    <Text size="xs" c="dimmed">
                      {advancedMode ? t('common.advancedModeOn') : t('common.advancedModeOff')}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {t('settings.advancedModeReveals')}
                    </Text>
                    <Stack gap={4} component="ul" pl="md" style={{ margin: 0 }}>
                      <Text size="xs" c="dimmed" component="li">
                        {t('settings.advancedModeRevealRun')}
                      </Text>
                      <Text size="xs" c="dimmed" component="li">
                        {t('settings.advancedModeRevealColumns')}
                      </Text>
                      <Text size="xs" c="dimmed" component="li">
                        {t('settings.advancedModeRevealDoctor')}
                      </Text>
                    </Stack>
                  </Stack>
                </Paper>
              </SimpleGrid>

              {/* Identity — the name stamped into test-case "Edited By" */}
              <Paper p="md" withBorder>
                <Title order={2} size="h5" mb="sm">
                  {t('user.identity')}
                </Title>
                <Stack gap="sm">
                  <Stack gap={2}>
                    <Text size="sm">{t('user.name')}</Text>
                    <Text size="xs" c="dimmed">
                      {t('user.nameDesc')}
                    </Text>
                  </Stack>
                  {hubUser.isLoading ? (
                    <Skeleton height={30} radius="sm" aria-hidden />
                  ) : (
                    <Group gap="xs" wrap="nowrap">
                      <TextInput
                        size="xs"
                        style={{ flex: 1 }}
                        leftSection={<TbUser size={14} />}
                        placeholder={t('user.namePlaceholder')}
                        value={nameInput}
                        onChange={(e) => setNameInput(e.currentTarget.value)}
                        error={saveUser.error ? saveUser.error.message : null}
                      />
                      <Button
                        size="xs"
                        loading={saveUser.isPending}
                        disabled={
                          nameInput.trim() === '' || nameInput.trim() === (hubUser.user?.name ?? '')
                        }
                        onClick={() =>
                          saveUser.mutate(nameInput.trim(), {
                            onSuccess: (res) =>
                              toast.success(
                                res.rowsRenamed > 0
                                  ? `${t('user.renamed')} — ${res.rowsRenamed} ${t('user.rowsUpdated')}`
                                  : t('user.saved'),
                              ),
                          })
                        }
                      >
                        {t('common.save')}
                      </Button>
                    </Group>
                  )}
                </Stack>
              </Paper>
            </>
          )}

          {category === 'execution' && (
            <>
              {/* Execution */}
              <Paper p="md" withBorder>
                <Title order={2} size="h5" mb="sm">
                  {t('settings.execution')}
                </Title>
                <Stack gap="sm">
                  <Group justify="space-between">
                    <Stack gap={2}>
                      <Text size="sm">{t('settings.maxConcurrent')}</Text>
                      <Text size="xs" c="dimmed">
                        {t('settings.maxConcurrentDesc')}
                        {concurrencyQ.data && concurrencyQ.data.queueLength > 0 && (
                          <Text span c="blue">
                            {' '}
                            ({concurrencyQ.data.queueLength} {t('settings.queued')})
                          </Text>
                        )}
                      </Text>
                    </Stack>
                    {/* Reserve the control's space while the saved value loads —
                  otherwise the input renders empty and then snaps to a number. */}
                    {concurrencyQ.isLoading ? (
                      <Skeleton height={30} width={132} radius="sm" aria-hidden />
                    ) : (
                      <Group gap="xs">
                        <NumberInput
                          size="xs"
                          w={80}
                          min={1}
                          max={10}
                          value={concurrencyInput}
                          onChange={(v) => setConcurrencyInput(typeof v === 'number' ? v : '')}
                        />
                        <Button
                          size="xs"
                          onClick={() => {
                            if (typeof concurrencyInput === 'number')
                              concurrencyMutation.mutate(concurrencyInput);
                          }}
                          loading={concurrencyMutation.isPending}
                          disabled={
                            !concurrencyInput ||
                            concurrencyInput === concurrencyQ.data?.maxConcurrency
                          }
                        >
                          {t('common.save')}
                        </Button>
                      </Group>
                    )}
                  </Group>
                </Stack>
              </Paper>

              {/* Run Defaults */}
              <Paper p="md" withBorder>
                <Title order={2} size="h5" mb="sm">
                  {t('settings.runDefaults')}
                </Title>
                <Stack gap="sm">
                  <Group justify="space-between">
                    <Stack gap={2}>
                      <Text size="sm">{t('settings.defaultTool')}</Text>
                      <Text size="xs" c="dimmed">
                        {t('settings.defaultToolDesc')}
                      </Text>
                    </Stack>
                    <Select
                      size="xs"
                      w={160}
                      value={lastTool}
                      onChange={(v) => v && setLastTool(v as ToolId)}
                      data={toolOptions}
                      allowDeselect={false}
                    />
                  </Group>

                  <Group justify="space-between">
                    <Stack gap={2}>
                      <Text size="sm">{t('settings.defaultMode')}</Text>
                      <Text size="xs" c="dimmed">
                        {t('settings.defaultModeDesc')}
                      </Text>
                    </Stack>
                    <Select
                      size="xs"
                      w={140}
                      value={defaultMode}
                      onChange={(v) => v && setDefaultMode(v as 'local' | 'docker')}
                      data={[
                        { value: 'local', label: t('run.modeLocal') },
                        { value: 'docker', label: 'Docker' },
                      ]}
                      allowDeselect={false}
                    />
                  </Group>

                  <Group justify="space-between">
                    <Stack gap={2}>
                      <Text size="sm">{t('settings.defaultDisplay')}</Text>
                      <Text size="xs" c="dimmed">
                        {t('settings.defaultDisplayDesc')}
                      </Text>
                    </Stack>
                    <Select
                      size="xs"
                      w={140}
                      value={defaultHeadless}
                      onChange={(v) => v && setDefaultHeadless(v as 'headless' | 'headed')}
                      data={[
                        { value: 'headless', label: t('run.headless') },
                        { value: 'headed', label: t('run.headed') },
                      ]}
                      allowDeselect={false}
                    />
                  </Group>
                </Stack>
              </Paper>
            </>
          )}

          {category === 'notifications' && (
            <>
              {/* Notifications */}
              <Paper p="md" withBorder>
                <Title order={2} size="h5" mb="sm">
                  {t('settings.notifications')}
                </Title>
                <Stack gap="sm">
                  <Group justify="space-between">
                    <Stack gap={2}>
                      <Text size="sm">{t('settings.soundNotifications')}</Text>
                      <Text size="xs" c="dimmed">
                        {t('settings.soundNotificationsDesc')}
                      </Text>
                    </Stack>
                    <Switch
                      checked={soundEnabled}
                      onChange={toggleSound}
                      size="md"
                      aria-label={t('settings.soundNotifications')}
                    />
                  </Group>
                  <Group justify="space-between">
                    <Stack gap={2}>
                      <Text size="sm">{t('settings.desktopNotifications')}</Text>
                      <Text size="xs" c="dimmed">
                        {t('settings.desktopNotificationsDesc')}
                      </Text>
                    </Stack>
                    <Switch
                      checked={desktopEnabled}
                      onChange={(e) => handleToggleDesktop(e.currentTarget.checked)}
                      size="md"
                      aria-label={t('settings.desktopNotifications')}
                    />
                  </Group>
                </Stack>
              </Paper>

              <Paper p="md" withBorder>
                <Stack gap={4} mb="sm">
                  <Title order={2} size="h5">
                    {t('settings.webhooks')}
                  </Title>
                  <Text size="xs" c="dimmed">
                    {t('settings.webhooksDesc')}
                  </Text>
                </Stack>
                <WebhooksBody />
              </Paper>
            </>
          )}

          {category === 'data' && (
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
                    <Group
                      gap="xs"
                      style={{ cursor: 'pointer' }}
                      onClick={() => setHistoryOpen((v) => !v)}
                    >
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
                      <Switch
                        checked={showOnboarding}
                        onChange={() => toggleOnboarding()}
                        size="md"
                      />
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
          )}

          {category === 'system' && (
            <>
              {/* System Update */}
              <Paper p="md" withBorder>
                <Title order={2} size="h5" mb="sm">
                  {t('settings.systemUpdate')}
                </Title>
                <Stack gap="sm">
                  <Group justify="space-between">
                    <Stack gap={2}>
                      <Text size="sm">{t('settings.updateHub')}</Text>
                      <Text size="xs" c="dimmed">
                        {t('settings.updateHubDesc')}
                      </Text>
                      {updateStatus && (
                        <Text size="xs" c="blue" fw={500}>
                          {updateStatus}
                        </Text>
                      )}
                    </Stack>
                    <Button
                      size="xs"
                      variant="light"
                      color="blue"
                      leftSection={<TbRefresh size={14} />}
                      loading={isUpdating}
                      disabled={isUpdating}
                      onClick={runUpdate}
                    >
                      {isUpdating ? t('settings.updating') : t('settings.update')}
                    </Button>
                  </Group>
                </Stack>
              </Paper>

              <UsageLoggingSetup />

              <Paper p="md" withBorder>
                <Stack gap={4} mb="sm">
                  <Group gap="xs">
                    <TbBrandDocker size={18} />
                    <Title order={2} size="h5">
                      {t('settings.dockerServices')}
                    </Title>
                  </Group>
                  <Text size="xs" c="dimmed">
                    {t('settings.dockerServicesDesc')}
                  </Text>
                </Stack>
                <DockerServicesBody />
              </Paper>
            </>
          )}

          {category === 'about' && (
            <>
              {/* About */}
              <Paper p="md" withBorder>
                <Title order={2} size="h5" mb="sm">
                  {t('settings.about')}
                </Title>
                <Stack gap={4}>
                  <Text size="xs" c="dimmed">
                    AutoQA Hub v{import.meta.env.VITE_APP_VERSION} — Test Execution Manager
                  </Text>
                  <Text size="xs" c="dimmed">
                    Copyright © 2026-present{' '}
                    <Anchor
                      href="https://www.linkedin.com/in/decha-laowraddecha-56b686232/"
                      target="_blank"
                      underline="always"
                    >
                      Decha_L
                    </Anchor>
                    . {t('settings.allRightsReserved')}
                  </Text>
                </Stack>
              </Paper>

              {/* Support / Donate — drop your PromptPay QR image at
          hub/client/public/promptpay-qr.png (served at /promptpay-qr.png). */}
              <Paper p="md" withBorder>
                <Title order={2} size="h5" mb="sm">
                  {t('settings.support')}
                </Title>
                <Stack gap={6}>
                  <Text size="sm">{t('settings.supportDesc')}</Text>
                  <Button
                    variant="subtle"
                    size="compact-sm"
                    px={0}
                    leftSection={<TbQrcode size={16} />}
                    onClick={openQr}
                    style={{ alignSelf: 'flex-start' }}
                  >
                    {t('settings.scanToDonate')}
                  </Button>
                </Stack>
              </Paper>
            </>
          )}
        </Stack>
      </Flex>

      <Modal opened={qrOpened} onClose={closeQr} title={t('settings.support')} centered size="auto">
        <Stack align="center" gap="sm">
          <img
            src="/promptpay-qr.png"
            alt="PromptPay QR"
            style={{
              width: 280,
              height: 280,
              objectFit: 'contain',
              background: '#fff',
              borderRadius: 8,
              padding: 8,
            }}
            // If the QR image isn't added yet, show a hint instead of a broken icon.
            onError={(e) => {
              const img = e.currentTarget as HTMLImageElement;
              img.style.display = 'none';
              img.insertAdjacentText('afterend', 'PromptPay QR not set yet.');
            }}
          />
          <Text size="xs" c="dimmed">
            {t('settings.scanToDonate')}
          </Text>
        </Stack>
      </Modal>
    </Stack>
  );
}
