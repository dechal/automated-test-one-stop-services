import { Anchor, Button, Modal, Paper, Stack, Text, Title } from '@mantine/core';
import { TbQrcode } from 'react-icons/tb';
import { useT } from '~/i18n';

export function AboutSettings({ openQr }: { openQr: () => void }) {
  const t = useT();
  return (
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
  );
}

export function DonateQrModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const t = useT();
  return (
    <Modal opened={opened} onClose={onClose} title={t('settings.support')} centered size="auto">
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
  );
}
