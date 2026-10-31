import type { ManifestPreview } from '@hub/shared';
import { Alert, Badge, Button, Card, Code, Group, Modal, Stack, Text } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { TbDownload } from 'react-icons/tb';
import { api } from '~/api/client.js';
import { toast } from '~/components/Toast.js';
import { useConfirmInstall, useInstallTool, useRegistry } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';

interface AddToolsModalProps {
  opened: boolean;
  onClose: () => void;
  onInstalled: () => void;
}

/**
 * Marketplace dialog opened from the Projects header ("Add other tools").
 * Lists `tool-registry.json` entries and runs the two-phase install:
 *   1. preview — clone + validate, show manifest preview
 *   2. confirm — wire into the workspace and re-sync
 * Cancelling after preview aborts (removes the cloned folder) server-side.
 */
export function AddToolsModal({ opened, onClose, onInstalled }: AddToolsModalProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const registry = useRegistry(opened);
  const install = useInstallTool();
  const confirm = useConfirmInstall();
  const [preview, setPreview] = useState<ManifestPreview | null>(null);

  function reset() {
    setPreview(null);
    install.reset();
    confirm.reset();
  }

  function handleClose() {
    // If a preview was generated but not confirmed, abort to clean the clone.
    if (preview) {
      api.post('/api/tools/install', { name: preview.id, abort: true }).catch(() => {});
    }
    reset();
    onClose();
  }

  function startInstall(name: string) {
    install.mutate(name, {
      onSuccess: (p) => setPreview(p),
      onError: (e) => toast.error(e instanceof Error ? e.message : t('addTools.installFailed')),
    });
  }

  function confirmInstall() {
    if (!preview) return;
    confirm.mutate(preview.id, {
      onSuccess: async () => {
        toast.success(`${t('addTools.installedToast')} ${preview.title}`);
        // Refetch registry while modal is still open (enabled=true) so cached
        // data reflects the newly-installed tool before we close.
        await queryClient.invalidateQueries({ queryKey: ['tool-registry'] });
        reset();
        onInstalled();
        onClose();
      },
      onError: (e) => toast.error(e instanceof Error ? e.message : t('addTools.installFailed')),
    });
  }

  const entries = registry.data?.entries ?? [];

  return (
    <Modal opened={opened} onClose={handleClose} title={t('projects.addTools')} size="lg" centered>
      {preview ? (
        <Stack gap="sm">
          <Text size="sm" fw={600}>
            {t('addTools.confirmInstallColon')} {preview.title}
          </Text>
          <Card withBorder padding="sm" radius="sm">
            <Stack gap={4}>
              <Group gap="xs">
                <Code>{preview.id}</Code>
                <Badge size="xs" variant="light">
                  v{preview.version}
                </Badge>
                <Badge size="xs" variant="light" color="grape">
                  {preview.runtime}
                </Badge>
                <Badge size="xs" variant="light" color="blue">
                  {preview.packageManager}
                </Badge>
              </Group>
              <Text size="xs" c="dimmed">
                alias: {preview.alias} · projects depth {preview.projects.depth}
                {preview.projects.typeAxis ? ' · typed' : ''}
              </Text>
              <Text size="xs" c="dimmed">
                base image: <Code>{preview.dockerBaseImage}</Code>
              </Text>
            </Stack>
          </Card>
          <Text size="xs" c="dimmed">
            {t('addTools.confirmHint')}
          </Text>
          <Group justify="flex-end" gap="xs">
            <Button variant="subtle" color="gray" size="xs" onClick={handleClose}>
              {t('common.cancel')}
            </Button>
            <Button size="xs" loading={confirm.isPending} onClick={confirmInstall}>
              {t('addTools.confirmInstall')}
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack gap="sm">
          {registry.isLoading && (
            <Text size="sm" c="dimmed">
              {t('addTools.loadingRegistry')}
            </Text>
          )}
          {!registry.isLoading && entries.length === 0 && (
            <Text size="sm" c="dimmed">
              {t('addTools.emptyRegistry')} <Code>scripts/manifests/data/tool-registry.json</Code>.
            </Text>
          )}
          {entries.map((entry) => (
            <Card key={entry.name} withBorder padding="sm" radius="sm">
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <div style={{ minWidth: 0 }}>
                  <Group gap="xs">
                    <Text size="sm" fw={600}>
                      {entry.title}
                    </Text>
                    <Badge size="xs" variant="light" color="gray">
                      {entry.ref}
                    </Badge>
                  </Group>
                  <Text size="xs" c="dimmed" mt={2} lineClamp={2}>
                    {entry.description}
                  </Text>
                </div>
                {entry.installed ? (
                  <Badge color="green" variant="light">
                    {t('addTools.installed')}
                  </Badge>
                ) : (
                  <Button
                    size="xs"
                    leftSection={<TbDownload size={14} />}
                    loading={install.isPending && install.variables === entry.name}
                    onClick={() => startInstall(entry.name)}
                  >
                    {t('addTools.install')}
                  </Button>
                )}
              </Group>
            </Card>
          ))}
          {install.isError && (
            <Alert color="red" variant="light">
              {install.error instanceof Error ? install.error.message : t('addTools.installFailed')}
            </Alert>
          )}
        </Stack>
      )}
    </Modal>
  );
}
