import { ActionIcon, Button, Group, Menu, Tooltip } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { TbCheck, TbChevronDown, TbPlayerPlay, TbPlayerStop } from 'react-icons/tb';
import { api } from '~/api/client.js';
import { qAndroidEmulator, qDoctor, queryRoots } from '~/api/queries.js';
import { toast } from '~/components/Toast.js';
import { useT } from '~/i18n/index.js';
import { usePreferences } from '~/stores/hub.js';

const WATCH_POLL_MS = 3_000;
const WATCH_WINDOW_MS = 120_000;

export function EmulatorControls({ size = 'compact-xs' }: { size?: 'compact-xs' | 'xs' }) {
  const t = useT();
  const queryClient = useQueryClient();
  const lastAvd = usePreferences((s) => s.lastAvd);
  const setLastAvd = usePreferences((s) => s.setLastAvd);
  const [watchUntil, setWatchUntil] = useState(0);
  const data = useQuery(qAndroidEmulator()).data;
  const status = data && Array.isArray(data.avds) ? data : undefined;
  const running = status?.running ?? [];
  const watching = Date.now() < watchUntil;
  const poll = watching ? WATCH_POLL_MS : false;
  useQuery({ ...qAndroidEmulator(), refetchInterval: poll });
  useQuery({ ...qDoctor(), refetchInterval: poll });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: [queryRoots.androidEmulator] });
    queryClient.invalidateQueries({ queryKey: [queryRoots.doctor] });
  };
  const start = useMutation({
    mutationFn: (avd: string) => api.post('/api/android-emulator/start', { avd }),
    onSuccess: (_data, avd) => {
      setLastAvd(avd);
      toast.success(t('emulator.starting').replace('{avd}', avd));
      setWatchUntil(Date.now() + WATCH_WINDOW_MS);
      refresh();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const stop = useMutation({
    mutationFn: () => api.post('/api/android-emulator/stop', {}),
    onSuccess: () => {
      setWatchUntil(Date.now() + WATCH_WINDOW_MS);
      refresh();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  if (!status) return null;
  if (running.length > 0) {
    return (
      <Button
        size={size}
        variant="default"
        leftSection={<TbPlayerStop size={12} />}
        loading={stop.isPending}
        onClick={() => stop.mutate()}
      >
        {t('emulator.stop')}
      </Button>
    );
  }

  const avds = status.avds;
  if (avds.length === 0) {
    return (
      <Tooltip label={status.error ?? t('emulator.noAvd')} withArrow multiline maw={320}>
        <Button size={size} variant="light" leftSection={<TbPlayerPlay size={12} />} disabled>
          {t('emulator.start')}
        </Button>
      </Tooltip>
    );
  }

  const chosen = avds.includes(lastAvd) ? lastAvd : (avds[0] ?? '');
  const starting = start.isPending || (watching && running.length === 0);
  return (
    <Group gap={0} wrap="nowrap">
      <Button
        size={size}
        variant="light"
        leftSection={<TbPlayerPlay size={12} />}
        loading={starting}
        onClick={() => start.mutate(chosen)}
        style={
          avds.length > 1 ? { borderTopRightRadius: 0, borderBottomRightRadius: 0 } : undefined
        }
      >
        {t('emulator.startAvd').replace('{avd}', chosen)}
      </Button>
      {avds.length > 1 && (
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon
              variant="light"
              size={size === 'xs' ? 30 : 22}
              disabled={starting}
              aria-label={t('emulator.chooseAvd')}
              style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }}
            >
              <TbChevronDown size={12} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>{t('emulator.chooseAvd')}</Menu.Label>
            {avds.map((avd) => (
              <Menu.Item
                key={avd}
                leftSection={
                  avd === chosen ? <TbCheck size={12} /> : <span style={{ width: 12 }} />
                }
                onClick={() => start.mutate(avd)}
              >
                {avd}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      )}
    </Group>
  );
}
