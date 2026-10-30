import {
  Badge,
  Button,
  Card,
  Group,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  TbBrandDocker,
  TbDeviceMobile,
  TbDownload,
  TbPlayerPlay,
  TbPlayerStop,
  TbRefresh,
  TbServer,
} from 'react-icons/tb';
import { api } from '~/api/client';
import { qAppiumStatus, qDockerStatus, queryRoots } from '~/api/queries.js';
import { ErrorState } from '~/components/ErrorState.js';
import { GridSkeleton } from '~/components/Skeletons.js';
import { toast } from '~/components/Toast';
import { type TranslationKey, useT } from '~/i18n/index.js';

/**
 * Poll interval for the Docker/Appium probes. Each poll shells out to the
 * `docker` CLI on the server, so this is the page's real cost — 10s still feels
 * live for start/stop actions (which invalidate the query immediately) at half
 * the process churn of the previous 5s.
 */
const STATUS_POLL_MS = 10_000;

const SERVICE_INFO: Record<string, { label: string; port: number; descKey: TranslationKey }> = {
  influxdb: { label: 'InfluxDB', port: 8086, descKey: 'docker.influxDesc' },
  grafana: { label: 'Grafana', port: 3000, descKey: 'docker.grafanaDesc' },
};

export function DockerServicesBody() {
  const t = useT();
  const queryClient = useQueryClient();

  const status = useQuery({
    ...qDockerStatus(),
    refetchInterval: STATUS_POLL_MS,
  });

  const dockerRunning = status.data?.dockerRunning ?? false;

  const startDesktop = useMutation({
    mutationFn: () => api.post('/api/docker/start-desktop'),
    onSuccess: () => {
      toast.success(t('docker.desktopStarting'));
      queryClient.invalidateQueries({ queryKey: [queryRoots.dockerStatus] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const startService = useMutation({
    mutationFn: (name: string) => api.post('/api/docker/service/start', { service: name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [queryRoots.dockerStatus] });
      queryClient.invalidateQueries({ queryKey: [queryRoots.doctor] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const stopService = useMutation({
    mutationFn: (name: string) => api.post('/api/docker/service/stop', { service: name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [queryRoots.dockerStatus] });
      queryClient.invalidateQueries({ queryKey: [queryRoots.doctor] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const restartService = useMutation({
    mutationFn: (name: string) => api.post('/api/docker/service/restart', { service: name }),
    onSuccess: () => {
      toast.success(t('docker.serviceRestarting'));
      queryClient.invalidateQueries({ queryKey: [queryRoots.dockerStatus] });
      queryClient.invalidateQueries({ queryKey: [queryRoots.doctor] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const startAll = useMutation({
    mutationFn: () => api.post('/api/docker/start-all'),
    onSuccess: () => {
      toast.success(t('docker.startingAll'));
      queryClient.invalidateQueries({ queryKey: [queryRoots.dockerStatus] });
      queryClient.invalidateQueries({ queryKey: [queryRoots.doctor] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const stopAll = useMutation({
    mutationFn: () => api.post('/api/docker/stop-all'),
    onSuccess: () => {
      toast.success(t('docker.stoppingAll'));
      queryClient.invalidateQueries({ queryKey: [queryRoots.dockerStatus] });
      queryClient.invalidateQueries({ queryKey: [queryRoots.doctor] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const appium = useQuery({
    ...qAppiumStatus(),
    refetchInterval: STATUS_POLL_MS,
  });
  const appiumStart = useMutation({
    mutationFn: () => api.post('/api/appium/start'),
    onSuccess: () => {
      toast.success(t('docker.appiumStarting'));
      queryClient.invalidateQueries({ queryKey: [queryRoots.appiumStatus] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const appiumStop = useMutation({
    mutationFn: () => api.post('/api/appium/stop'),
    onSuccess: () => {
      toast.success(t('docker.appiumStopped'));
      queryClient.invalidateQueries({ queryKey: [queryRoots.appiumStatus] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const appiumInstall = useMutation({
    mutationFn: () => api.post('/api/appium/install'),
    onSuccess: () => {
      toast.success(t('docker.appiumInstalled'));
      queryClient.invalidateQueries({ queryKey: [queryRoots.appiumStatus] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  function getServiceStatus(name: string): 'running' | 'stopped' {
    const svcStatus = status.data?.services?.[name];
    return svcStatus === 'running' ? 'running' : 'stopped';
  }

  return (
    <Stack gap="md">
      {/* Probing Docker can take a few seconds. Mirror the real layout (status
          card → bulk actions → service cards) so the page never looks stuck and
          nothing jumps when the data lands. */}
      {status.isError && <ErrorState onRetry={() => status.refetch()} />}
      {status.isLoading && (
        <Stack gap="md">
          <Text c="dimmed" size="sm">
            {t('docker.checking')}
          </Text>
          <Skeleton height={86} radius="md" aria-hidden />
          <Group gap="xs" aria-hidden>
            <Skeleton height={26} width={104} radius="sm" />
            <Skeleton height={26} width={104} radius="sm" />
          </Group>
          <GridSkeleton count={3} cols={{ base: 1, sm: 2, md: 3 }} height={188} />
        </Stack>
      )}

      {!status.isLoading && (
        <>
          {/* Docker Desktop status */}
          <Card withBorder p="md">
            <Group justify="space-between">
              <Group gap="md">
                <TbBrandDocker size={24} />
                <Stack gap={2}>
                  <Text size="sm" fw={500}>
                    Docker Desktop
                  </Text>
                  <Badge size="sm" variant="light" color={dockerRunning ? 'green' : 'red'}>
                    {dockerRunning ? t('common.running') : t('common.stopped')}
                  </Badge>
                </Stack>
              </Group>
              {!dockerRunning && (
                <Button
                  size="xs"
                  leftSection={<TbPlayerPlay size={14} />}
                  onClick={() => startDesktop.mutate()}
                  loading={startDesktop.isPending}
                >
                  {t('docker.startDesktop')}
                </Button>
              )}
            </Group>
          </Card>

          {/* Bulk actions */}
          <Group gap="xs">
            <Button
              size="xs"
              variant="light"
              leftSection={<TbPlayerPlay size={14} />}
              onClick={() => startAll.mutate()}
              loading={startAll.isPending}
              disabled={!dockerRunning}
            >
              {t('docker.startAll')}
            </Button>
            <Button
              size="xs"
              variant="default"
              leftSection={<TbPlayerStop size={14} />}
              onClick={() => stopAll.mutate()}
              loading={stopAll.isPending}
              disabled={!dockerRunning}
            >
              {t('docker.stopAll')}
            </Button>
          </Group>

          {/* Service cards */}
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
            {Object.entries(SERVICE_INFO).map(([name, info]) => {
              const svcStatus = getServiceStatus(name);
              const isRunning = svcStatus === 'running';

              return (
                <Card key={name} withBorder p="md">
                  <Stack gap="sm">
                    <Group justify="space-between">
                      <Group gap="xs">
                        <TbServer size={16} />
                        <Text size="sm" fw={500}>
                          {info.label}
                        </Text>
                      </Group>
                      <Badge size="sm" variant="light" color={isRunning ? 'green' : 'red'}>
                        {isRunning ? t('common.running') : t('common.stopped')}
                      </Badge>
                    </Group>

                    <Stack gap={2}>
                      <Text size="xs" c="dimmed">
                        {t(info.descKey)}
                      </Text>
                      <Text size="xs" c="dimmed" ff="monospace">
                        :{info.port}
                      </Text>
                    </Stack>

                    <Group gap="xs">
                      {!isRunning && (
                        <Tooltip label={t('docker.startService')}>
                          <Button
                            size="xs"
                            variant="light"
                            leftSection={<TbPlayerPlay size={12} />}
                            onClick={() => startService.mutate(name)}
                            disabled={!dockerRunning}
                            loading={startService.isPending && startService.variables === name}
                          >
                            {t('common.start')}
                          </Button>
                        </Tooltip>
                      )}
                      {isRunning && (
                        <Tooltip label={t('docker.stopService')}>
                          <Button
                            size="xs"
                            variant="default"
                            leftSection={<TbPlayerStop size={12} />}
                            onClick={() => stopService.mutate(name)}
                            disabled={!dockerRunning}
                            loading={stopService.isPending && stopService.variables === name}
                          >
                            {t('common.stop')}
                          </Button>
                        </Tooltip>
                      )}
                      <Tooltip label={t('docker.restartService')}>
                        <Button
                          size="xs"
                          variant="light"
                          color="blue"
                          leftSection={<TbRefresh size={12} />}
                          onClick={() => restartService.mutate(name)}
                          disabled={!dockerRunning || !isRunning}
                          loading={restartService.isPending && restartService.variables === name}
                        >
                          {t('common.restart')}
                        </Button>
                      </Tooltip>
                    </Group>
                  </Stack>
                </Card>
              );
            })}
          </SimpleGrid>
        </>
      )}

      {/* Local services — host processes (not Docker). Appium runs on the host
          for mobile testing (host emulator + host appium); Docker can't run an
          Android emulator on Windows. */}
      <div>
        <Text size="sm" fw={700} c="dimmed" tt="uppercase" mb="xs">
          {t('docker.localServices')}
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
          <Card withBorder p="md">
            <Stack gap="sm">
              <Group justify="space-between">
                <Group gap="xs">
                  <TbDeviceMobile size={16} />
                  <Text size="sm" fw={500}>
                    {t('docker.appiumLocal')}
                  </Text>
                </Group>
                <Badge size="sm" variant="light" color={appium.data?.running ? 'green' : 'red'}>
                  {appium.data?.running ? t('common.running') : t('common.stopped')}
                </Badge>
              </Group>

              <Stack gap={2}>
                <Text size="xs" c="dimmed">
                  {t('docker.appiumDesc')}
                </Text>
                <Text size="xs" c="dimmed" ff="monospace">
                  :{appium.data?.port ?? 4723}
                </Text>
              </Stack>

              {appium.data && !appium.data.installed ? (
                <Tooltip label={t('docker.installAppiumTip')}>
                  <Button
                    size="xs"
                    variant="default"
                    leftSection={<TbDownload size={12} />}
                    onClick={() => appiumInstall.mutate()}
                    loading={appiumInstall.isPending}
                  >
                    {t('common.install')}
                  </Button>
                </Tooltip>
              ) : (
                <Group gap="xs">
                  {!appium.data?.running && (
                    <Button
                      size="xs"
                      variant="light"
                      leftSection={<TbPlayerPlay size={12} />}
                      onClick={() => appiumStart.mutate()}
                      loading={appiumStart.isPending}
                    >
                      {t('common.start')}
                    </Button>
                  )}
                  {appium.data?.running && (
                    <Button
                      size="xs"
                      variant="default"
                      leftSection={<TbPlayerStop size={12} />}
                      onClick={() => appiumStop.mutate()}
                      loading={appiumStop.isPending}
                    >
                      {t('common.stop')}
                    </Button>
                  )}
                </Group>
              )}
            </Stack>
          </Card>
        </SimpleGrid>
      </div>
    </Stack>
  );
}
