import type {
  AddRemoteRequest,
  DeleteRemoteRequest,
  RemoteEntry,
  SetRemoteUrlRequest,
} from '@hub/shared';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Modal,
  Paper,
  Skeleton,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { TbAlertTriangle, TbLock, TbPencil, TbPlus, TbTrash } from 'react-icons/tb';
import { api } from '~/api/client.js';
import { qRemotes, queryRoots } from '~/api/queries.js';
import { ErrorState } from '~/components/ErrorState.js';
import { toast } from '~/components/Toast.js';
import { TypeToConfirmModal } from '~/components/TypeToConfirmModal.js';
import { useT } from '~/i18n/index.js';

const ORIGIN = 'origin';
const WRITE_TIMEOUT_MS = 45_000;
const REMOTE_NAME_WIDTH = 96;
const MODAL_WIDTH = '56rem';

interface RepoRemotesModalProps {
  repoId: string | null;
  onClose: () => void;
}

interface RemoteRowProps {
  repoId: string;
  remote: RemoteEntry;
  onDelete: (remote: RemoteEntry) => void;
}

function RemoteRow({ repoId, remote, onDelete }: RemoteRowProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(remote.url);
  const [error, setError] = useState<string | null>(null);

  const saveMutation = useMutation<unknown, Error, SetRemoteUrlRequest>({
    mutationFn: (body) => api.post('/api/remotes/set-url', body, { timeout: WRITE_TIMEOUT_MS }),
    onSuccess: () => {
      toast.success(t('remotes.saved'));
      setEditing(false);
      setError(null);
      queryClient.invalidateQueries({ queryKey: [queryRoots.remotes] });
    },
    onError: (err) => setError(err.message || t('remotes.error')),
  });

  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && trimmed !== remote.url;

  function startEdit() {
    setValue(remote.url);
    setError(null);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setError(null);
  }

  function save() {
    if (canSave) saveMutation.mutate({ repo: repoId, name: remote.name, url: trimmed });
  }

  return (
    <Paper p="xs" radius="sm" bg="var(--mantine-color-default-hover)" withBorder>
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
            <Text size="sm" fw={500} w={REMOTE_NAME_WIDTH} style={{ flexShrink: 0 }}>
              {remote.name}
            </Text>
            {!editing && (
              <Tooltip label={remote.url} openDelay={300} withArrow>
                <Text size="sm" ff="monospace" c="dimmed" truncate style={{ minWidth: 0 }}>
                  {remote.url}
                </Text>
              </Tooltip>
            )}
          </Group>
          {!editing && (
            <Group gap={4} wrap="nowrap">
              <Tooltip label={t('remotes.edit')}>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="gray"
                  onClick={startEdit}
                  aria-label={`${t('remotes.edit')} ${remote.name}`}
                >
                  <TbPencil size={14} />
                </ActionIcon>
              </Tooltip>
              {remote.name === ORIGIN ? (
                <Tooltip label={t('remotes.originLocked')} withArrow>
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="gray"
                    disabled
                    aria-label={t('remotes.originLocked')}
                  >
                    <TbLock size={14} />
                  </ActionIcon>
                </Tooltip>
              ) : (
                <Tooltip label={t('remotes.delete')}>
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="red"
                    onClick={() => onDelete(remote)}
                    aria-label={`${t('remotes.delete')} ${remote.name}`}
                  >
                    <TbTrash size={14} />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
          )}
        </Group>
        {editing && (
          <>
            <TextInput
              value={value}
              onChange={(e) => setValue(e.currentTarget.value)}
              aria-label={t('remotes.url')}
              autoFocus
              data-autofocus
              disabled={saveMutation.isPending}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
                if (e.key === 'Escape') cancelEdit();
              }}
            />
            {saveMutation.isPending && (
              <Text size="xs" c="dimmed">
                {t('remotes.verifying')}
              </Text>
            )}
            {error && (
              <Alert color="red" variant="light" icon={<TbAlertTriangle size={16} />}>
                {error}
              </Alert>
            )}
            <Group justify="flex-end" gap="xs">
              <Button
                variant="subtle"
                color="gray"
                size="xs"
                onClick={cancelEdit}
                disabled={saveMutation.isPending}
              >
                {t('remotes.cancel')}
              </Button>
              <Button size="xs" onClick={save} disabled={!canSave} loading={saveMutation.isPending}>
                {t('remotes.save')}
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Paper>
  );
}

interface AddRemoteFormProps {
  repoId: string;
}

function AddRemoteForm({ repoId }: AddRemoteFormProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setOpen(false);
    setName('');
    setUrl('');
    setError(null);
  }

  const addMutation = useMutation<unknown, Error, AddRemoteRequest>({
    mutationFn: (body) => api.post('/api/remotes/add', body, { timeout: WRITE_TIMEOUT_MS }),
    onSuccess: () => {
      toast.success(t('remotes.added'));
      reset();
      queryClient.invalidateQueries({ queryKey: [queryRoots.remotes] });
    },
    onError: (err) => setError(err.message || t('remotes.error')),
  });

  const canAdd = name.trim().length > 0 && url.trim().length > 0;

  if (!open) {
    return (
      <Button
        variant="light"
        size="xs"
        leftSection={<TbPlus size={14} />}
        onClick={() => setOpen(true)}
        style={{ alignSelf: 'flex-start' }}
      >
        {t('remotes.add')}
      </Button>
    );
  }

  return (
    <Paper p="xs" radius="sm" withBorder>
      <Stack gap="xs">
        <Text size="sm" fw={500}>
          {t('remotes.addTitle')}
        </Text>
        <TextInput
          label={t('remotes.name')}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          disabled={addMutation.isPending}
          autoFocus
          data-autofocus
        />
        <TextInput
          label={t('remotes.url')}
          value={url}
          onChange={(e) => setUrl(e.currentTarget.value)}
          disabled={addMutation.isPending}
        />
        {addMutation.isPending && (
          <Text size="xs" c="dimmed">
            {t('remotes.verifying')}
          </Text>
        )}
        {error && (
          <Alert color="red" variant="light" icon={<TbAlertTriangle size={16} />}>
            {error}
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
          <Button
            variant="subtle"
            color="gray"
            size="xs"
            onClick={reset}
            disabled={addMutation.isPending}
          >
            {t('remotes.cancel')}
          </Button>
          <Button
            size="xs"
            disabled={!canAdd}
            loading={addMutation.isPending}
            onClick={() => addMutation.mutate({ repo: repoId, name: name.trim(), url: url.trim() })}
          >
            {t('remotes.add')}
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

export function RepoRemotesModal({ repoId, onClose }: RepoRemotesModalProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const remotesQuery = useQuery({ ...qRemotes(), enabled: repoId !== null });
  const [deleteTarget, setDeleteTarget] = useState<RemoteEntry | null>(null);

  useEffect(() => {
    if (repoId === null) setDeleteTarget(null);
  }, [repoId]);

  const repo = remotesQuery.data?.repos.find((r) => r.id === repoId);

  const deleteMutation = useMutation<unknown, Error, DeleteRemoteRequest>({
    mutationFn: (body) => api.post('/api/remotes/delete', body, { timeout: WRITE_TIMEOUT_MS }),
    onSuccess: () => {
      toast.success(t('remotes.deleted'));
      setDeleteTarget(null);
      queryClient.invalidateQueries({ queryKey: [queryRoots.remotes] });
    },
    onError: (err) => toast.error(err.message || t('remotes.error')),
  });

  return (
    <>
      <Modal
        opened={repoId !== null}
        onClose={onClose}
        title={
          <Group gap="xs">
            <Text fw={600}>{t('remotes.title')}</Text>
            {repoId && <Code>{repoId}</Code>}
          </Group>
        }
        size={MODAL_WIDTH}
        centered
      >
        {remotesQuery.isLoading ? (
          <Stack gap="xs">
            <Skeleton height={36} />
            <Skeleton height={36} />
          </Stack>
        ) : remotesQuery.isError ? (
          <ErrorState onRetry={() => remotesQuery.refetch()} message={remotesQuery.error.message} />
        ) : repo && repoId ? (
          <Stack gap="xs">
            {repo.error && (
              <Alert color="yellow" variant="light" icon={<TbAlertTriangle size={16} />}>
                {repo.error}
              </Alert>
            )}
            {repo.remotes.length === 0 && (
              <Text size="sm" c="dimmed">
                {t('remotes.noRemotes')}
              </Text>
            )}
            {repo.remotes.map((remote) => (
              <RemoteRow
                key={remote.name}
                repoId={repoId}
                remote={remote}
                onDelete={setDeleteTarget}
              />
            ))}
            <AddRemoteForm repoId={repoId} />
          </Stack>
        ) : null}
      </Modal>
      <TypeToConfirmModal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={t('remotes.deleteTitle')}
        description={
          deleteTarget ? (
            <>
              <Badge size="sm" variant="light" mr="xs">
                {deleteTarget.name}
              </Badge>
              {t('remotes.deleteDesc')}
            </>
          ) : null
        }
        expected={deleteTarget?.url ?? ''}
        confirmLabel={t('remotes.deleteConfirm')}
        loading={deleteMutation.isPending}
        onConfirm={() =>
          repoId &&
          deleteTarget &&
          deleteMutation.mutate({
            repo: repoId,
            name: deleteTarget.name,
            confirmUrl: deleteTarget.url,
          })
        }
      />
    </>
  );
}
