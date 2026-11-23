import { Button, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { TbBrandDocker, TbRefresh } from 'react-icons/tb';
import { UsageLoggingSetup } from '~/components/projects/UsageLoggingSetup.js';
import type { HubUpdateState } from '~/components/settings/useHubUpdate.js';
import { useT } from '~/i18n';

export function SystemSettings({ isUpdating, updateStatus, runUpdate }: HubUpdateState) {
  const t = useT();
  return (
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
    </>
  );
}
