import { type ReportDestination, reportDirError, reportDirKey } from '@hub/shared';
import {
  ActionIcon,
  Button,
  Divider,
  Group,
  Popover,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { TbBookmark, TbBookmarkPlus, TbCheck, TbPencil, TbTrash, TbX } from 'react-icons/tb';
import { api } from '~/api/client.js';
import { qReportDestinations, queryRoots } from '~/api/queries.js';
import { toast } from '~/components/Toast.js';
import { useT } from '~/i18n/index.js';

const POPOVER_WIDTH = 340;

function displayName(dest: ReportDestination): string {
  return dest.name?.trim() || dest.path.split(/[\\/]/).filter(Boolean).pop() || dest.path;
}

export function ReportDestinationMenu({
  value,
  onPick,
}: {
  value: string;
  onPick: (path: string) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState(false);
  const [name, setName] = useState('');
  const data = useQuery(qReportDestinations()).data;
  const destinations = Array.isArray(data) ? data : [];
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: [queryRoots.reportDestinations] });

  const save = useMutation({
    mutationFn: (body: { name: string; path: string }) =>
      api.post('/api/report-destinations', body),
    onSuccess: () => {
      toast.success(t('schedule.destSaved'));
      setName('');
      refresh();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const rename = useMutation({
    mutationFn: (body: { id: string; name: string }) =>
      api.put(`/api/report-destinations/${body.id}`, { name: body.name }),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/report-destinations/${id}`),
    onSuccess: refresh,
    onError: (err) => toast.error((err as Error).message),
  });

  const trimmed = value.trim();
  const alreadySaved = destinations.find(
    (d) => trimmed !== '' && reportDirKey(d.path) === reportDirKey(trimmed),
  );
  const pathValid = trimmed !== '' && reportDirError(trimmed, new Date()) === undefined;
  const canSave = pathValid && !alreadySaved && name.trim() !== '' && !save.isPending;

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      width={POPOVER_WIDTH}
      withinPortal
      shadow="md"
      trapFocus
    >
      <Popover.Target>
        <Tooltip label={t('schedule.destSavedList')} withArrow disabled={opened}>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={t('schedule.destSavedList')}
            onClick={() => setOpened((o) => !o)}
          >
            <TbBookmark size={14} />
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown p="xs">
        <Stack gap={4}>
          <Text size="xs" fw={600} c="dimmed" px={4}>
            {t('schedule.destSavedList')}
          </Text>
          {destinations.length === 0 && (
            <Text size="xs" c="dimmed" px={4} py={4}>
              {t('schedule.destNone')}
            </Text>
          )}
          {destinations.map((dest) =>
            editing?.id === dest.id ? (
              <Group key={dest.id} gap={4} wrap="nowrap">
                <TextInput
                  size="xs"
                  style={{ flex: 1 }}
                  value={editing.name}
                  aria-label={t('schedule.destName')}
                  data-autofocus
                  autoFocus
                  onChange={(e) => setEditing({ id: dest.id, name: e.currentTarget.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && editing.name.trim()) {
                      rename.mutate({ id: dest.id, name: editing.name.trim() });
                    }
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      setEditing(null);
                    }
                  }}
                />
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="teal"
                  aria-label={t('common.save')}
                  disabled={!editing.name.trim()}
                  loading={rename.isPending}
                  onClick={() => rename.mutate({ id: dest.id, name: editing.name.trim() })}
                >
                  <TbCheck size={14} />
                </ActionIcon>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="gray"
                  aria-label={t('common.cancel')}
                  onClick={() => setEditing(null)}
                >
                  <TbX size={14} />
                </ActionIcon>
              </Group>
            ) : (
              <Group key={dest.id} gap={4} wrap="nowrap">
                <Tooltip label={dest.path} withArrow multiline maw={POPOVER_WIDTH * 1.5}>
                  <UnstyledButton
                    px={4}
                    py={4}
                    style={{ flex: 1, minWidth: 0, borderRadius: 'var(--mantine-radius-sm)' }}
                    onClick={() => {
                      onPick(dest.path);
                      setOpened(false);
                    }}
                  >
                    <Text size="sm" truncate>
                      {displayName(dest)}
                    </Text>
                  </UnstyledButton>
                </Tooltip>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="gray"
                  aria-label={`${t('schedule.destRename')} ${displayName(dest)}`}
                  onClick={() => setEditing({ id: dest.id, name: displayName(dest) })}
                >
                  <TbPencil size={12} />
                </ActionIcon>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="red"
                  aria-label={`${t('schedule.destDelete')} ${displayName(dest)}`}
                  onClick={() => remove.mutate(dest.id)}
                >
                  <TbTrash size={12} />
                </ActionIcon>
              </Group>
            ),
          )}
          <Divider my={4} />
          {alreadySaved ? (
            <Text size="xs" c="yellow" px={4}>
              {t('schedule.destAlreadySaved').replace('{name}', displayName(alreadySaved))}
            </Text>
          ) : (
            <Group gap={6} wrap="nowrap" align="flex-end">
              <TextInput
                size="xs"
                style={{ flex: 1 }}
                label={t('schedule.destName')}
                placeholder={t('schedule.destNamePlaceholder')}
                value={name}
                disabled={!pathValid}
                onChange={(e) => setName(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSave)
                    save.mutate({ name: name.trim(), path: trimmed });
                }}
              />
              <Button
                size="xs"
                leftSection={<TbBookmarkPlus size={14} />}
                disabled={!canSave}
                loading={save.isPending}
                onClick={() => save.mutate({ name: name.trim(), path: trimmed })}
              >
                {t('schedule.destSaveCurrent')}
              </Button>
            </Group>
          )}
          {!pathValid && !alreadySaved && (
            <Text size="xs" c="dimmed" px={4}>
              {t('schedule.destEnterPathFirst')}
            </Text>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
