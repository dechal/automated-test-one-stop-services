import type { DoctorCheck } from '@hub/shared';
import { Button, Group } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { TbDownload, TbPlayerPlay, TbPlayerStop, TbRefresh } from 'react-icons/tb';
import { api } from '~/api/client.js';
import { qDoctor, queryRoots } from '~/api/queries.js';
import { EmulatorControls } from '~/components/EmulatorControls.js';
import { toast } from '~/components/Toast.js';
import { useT } from '~/i18n/index.js';

const DOCKER_CHECK = 'docker-running';
const WATCH_POLL_MS = 3_000;
const WATCH_WINDOW_MS = 120_000;

type ServiceAction =
  | { kind: 'docker-start' }
  | { kind: 'compose'; verb: 'start' | 'stop' | 'restart'; service: string }
  | { kind: 'appium'; verb: 'install' | 'start' | 'stop' };

function endpointFor(action: ServiceAction): { url: string; body?: { service: string } } {
  if (action.kind === 'docker-start') return { url: '/api/docker/start-desktop' };
  if (action.kind === 'appium') return { url: `/api/appium/${action.verb}` };
  return { url: `/api/docker/service/${action.verb}`, body: { service: action.service } };
}

function actionKey(action: ServiceAction): string {
  return action.kind === 'docker-start' ? action.kind : `${action.kind}:${action.verb}`;
}

export function ServiceActions({
  check,
  allChecks,
}: {
  check: DoctorCheck;
  allChecks: readonly DoctorCheck[];
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [watch, setWatch] = useState<{ fromOk: boolean; until: number } | null>(null);
  const watching = watch !== null && check.ok === watch.fromOk && Date.now() < watch.until;
  useQuery({ ...qDoctor(), refetchInterval: watching ? WATCH_POLL_MS : false });
  const mutation = useMutation({
    mutationFn: (action: ServiceAction) => {
      const { url, body } = endpointFor(action);
      return api.post(url, body);
    },
    onSuccess: () => {
      setWatch({ fromOk: check.ok, until: Date.now() + WATCH_WINDOW_MS });
      queryClient.invalidateQueries({ queryKey: [queryRoots.doctor] });
      queryClient.invalidateQueries({ queryKey: [queryRoots.dockerStatus] });
      queryClient.invalidateQueries({ queryKey: [queryRoots.appiumStatus] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const pendingKey = mutation.isPending && mutation.variables ? actionKey(mutation.variables) : '';
  const button = (action: ServiceAction, label: string, icon: ReactNode, variant = 'light') => (
    <Button
      size="compact-xs"
      variant={variant}
      leftSection={icon}
      loading={pendingKey === actionKey(action)}
      disabled={mutation.isPending && pendingKey !== actionKey(action)}
      onClick={() => mutation.mutate(action)}
    >
      {label}
    </Button>
  );

  if (check.service === 'docker') {
    if (check.ok) return null;
    return (
      <Group gap={6} mt={6} pl={22}>
        {button({ kind: 'docker-start' }, t('docker.startDesktop'), <TbPlayerPlay size={12} />)}
      </Group>
    );
  }

  if (check.service === 'android-emulator') {
    return (
      <Group gap={6} mt={6} pl={22}>
        <EmulatorControls />
      </Group>
    );
  }

  if (check.service === 'appium') {
    return (
      <Group gap={6} mt={6} pl={22}>
        {check.install === 'appium'
          ? button(
              { kind: 'appium', verb: 'install' },
              t('common.install'),
              <TbDownload size={12} />,
            )
          : check.ok
            ? button(
                { kind: 'appium', verb: 'stop' },
                t('common.stop'),
                <TbPlayerStop size={12} />,
                'default',
              )
            : button(
                { kind: 'appium', verb: 'start' },
                t('common.start'),
                <TbPlayerPlay size={12} />,
              )}
      </Group>
    );
  }

  if (check.service === 'compose') {
    const dockerUp = allChecks.some((c) => c.name === DOCKER_CHECK && c.ok);
    if (!dockerUp) return null;
    const service = check.name;
    return (
      <Group gap={6} mt={6} pl={22}>
        {check.ok
          ? button(
              { kind: 'compose', verb: 'stop', service },
              t('common.stop'),
              <TbPlayerStop size={12} />,
              'default',
            )
          : button(
              { kind: 'compose', verb: 'start', service },
              t('common.start'),
              <TbPlayerPlay size={12} />,
            )}
        {check.ok &&
          button(
            { kind: 'compose', verb: 'restart', service },
            t('common.restart'),
            <TbRefresh size={12} />,
            'subtle',
          )}
      </Group>
    );
  }

  return null;
}
