import { Flex, NavLink, Stack } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import {
  TbBell,
  TbDatabase,
  TbInfoCircle,
  TbPlayerPlay,
  TbServer,
  TbSettings,
} from 'react-icons/tb';
import { api } from '~/api/client';
import { qCleanupHistory, qConcurrency, qRetention, queryRoots } from '~/api/queries.js';
import { PageHeader } from '~/components/PageHeader.js';
import { AboutSettings, DonateQrModal } from '~/components/settings/AboutSettings.js';
import { DataSettings } from '~/components/settings/DataSettings.js';
import { ExecutionSettings } from '~/components/settings/ExecutionSettings.js';
import { GeneralSettings } from '~/components/settings/GeneralSettings.js';
import { NotificationSettings } from '~/components/settings/NotificationSettings.js';
import { SystemSettings } from '~/components/settings/SystemSettings.js';
import { useHubUpdate } from '~/components/settings/useHubUpdate.js';
import { toast } from '~/components/Toast';
import { useHubUser, useSaveHubUser } from '~/hooks/useHubUser.js';
import { useResyncWorkspace, useToolOptions } from '~/hooks/useTools.js';
import { type TranslationKey, useT } from '~/i18n';
import { settingsRoute } from '~/router';

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

export function SettingsPage() {
  const t = useT();
  const search = settingsRoute.useSearch();
  const [category, setCategory] = useState<SettingsCategory>(search.cat ?? 'general');
  const queryClient = useQueryClient();
  const resync = useResyncWorkspace();
  const toolOptions = useToolOptions();
  const [qrOpened, { open: openQr, close: closeQr }] = useDisclosure(false);

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

  const hubUpdate = useHubUpdate();

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
            <GeneralSettings
              hubUser={hubUser}
              saveUser={saveUser}
              nameInput={nameInput}
              setNameInput={setNameInput}
            />
          )}

          {category === 'execution' && (
            <ExecutionSettings
              concurrencyQ={concurrencyQ}
              concurrencyInput={concurrencyInput}
              setConcurrencyInput={setConcurrencyInput}
              concurrencyMutation={concurrencyMutation}
              toolOptions={toolOptions}
            />
          )}

          {category === 'notifications' && <NotificationSettings />}

          {category === 'data' && (
            <DataSettings
              retentionQ={retentionQ}
              cleanupDays={cleanupDays}
              setCleanupDays={setCleanupDays}
              autoCleanup={autoCleanup}
              setAutoCleanup={setAutoCleanup}
              retentionMutation={retentionMutation}
              cleanupMutation={cleanupMutation}
              cleanupHistoryQ={cleanupHistoryQ}
              historyOpen={historyOpen}
              setHistoryOpen={setHistoryOpen}
              resync={resync}
            />
          )}

          {category === 'system' && <SystemSettings {...hubUpdate} />}

          {category === 'about' && <AboutSettings openQr={openQr} />}
        </Stack>
      </Flex>

      <DonateQrModal opened={qrOpened} onClose={closeQr} />
    </Stack>
  );
}
