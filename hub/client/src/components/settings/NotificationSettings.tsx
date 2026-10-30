import { Group, Paper, Stack, Switch, Text, Title } from '@mantine/core';
import { toast } from '~/components/Toast';
import {
  requestDesktopPermission,
  useDesktopNotification,
} from '~/hooks/useDesktopNotification.js';
import { useNotificationSound } from '~/hooks/useNotificationSound.js';
import { useT } from '~/i18n';
import { WebhooksBody } from '~/pages/Webhooks.js';

export function NotificationSettings() {
  const t = useT();
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

  return (
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
  );
}
