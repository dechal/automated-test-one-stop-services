import type { RemoteEntry, RepoRemotes } from '@hub/shared';
import {
  ActionIcon,
  Badge,
  Button,
  CopyButton,
  Group,
  Modal,
  Paper,
  Skeleton,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { TbAlertTriangle, TbCheck, TbCopy, TbSearch, TbX } from 'react-icons/tb';
import { qRemotes } from '~/api/queries.js';
import { EmptyState } from '~/components/EmptyState.js';
import { ErrorState } from '~/components/ErrorState.js';
import { filterRepos } from '~/components/projects/remotes-filter.js';
import { useT } from '~/i18n/index.js';

const MODAL_WIDTH = '72rem';
const REMOTE_NAME_WIDTH = 96;

interface RemotesModalProps {
  opened: boolean;
  onClose: () => void;
  onManage: (repoId: string) => void;
}

function RemoteUrlLine({ remote }: { remote: RemoteEntry }) {
  const t = useT();
  return (
    <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
      <Text size="sm" fw={500} w={REMOTE_NAME_WIDTH} style={{ flexShrink: 0 }}>
        {remote.name}
      </Text>
      <Tooltip label={remote.url} openDelay={300} withArrow>
        <Text size="sm" ff="monospace" c="dimmed" truncate style={{ minWidth: 0, flex: 1 }}>
          {remote.url}
        </Text>
      </Tooltip>
      <CopyButton value={remote.url}>
        {({ copied, copy }) => (
          <Tooltip label={t('common.copy')} withArrow>
            <ActionIcon
              size="sm"
              variant="subtle"
              color={copied ? 'teal' : 'gray'}
              onClick={copy}
              aria-label={`${t('common.copy')} ${remote.name}`}
            >
              {copied ? <TbCheck size={14} /> : <TbCopy size={14} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  );
}

function RepoCard({ repo, onManage }: { repo: RepoRemotes; onManage: (repoId: string) => void }) {
  const t = useT();
  const name = repo.id.split('/').pop() ?? repo.id;
  const parent = repo.id.slice(0, repo.id.length - name.length);

  return (
    <Paper withBorder radius="sm" p="sm">
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap" gap="sm">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <Text fw={600} size="sm" truncate>
              {name}
            </Text>
            <Badge size="xs" variant="light" color="gray" style={{ flexShrink: 0 }}>
              {repo.kind}
            </Badge>
            <Text size="xs" c="dimmed" ff="monospace" truncate>
              {parent}
            </Text>
          </Group>
          <Button size="compact-xs" variant="default" onClick={() => onManage(repo.id)}>
            {t('remotes.manage')}
          </Button>
        </Group>
        {repo.error && (
          <Group gap={6} wrap="nowrap">
            <TbAlertTriangle size={14} color="var(--mantine-color-yellow-6)" />
            <Text size="xs" c="yellow">
              {repo.error}
            </Text>
          </Group>
        )}
        {repo.remotes.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('remotes.noRemotes')}
          </Text>
        ) : (
          <Stack gap={4}>
            {repo.remotes.map((remote) => (
              <RemoteUrlLine key={remote.name} remote={remote} />
            ))}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}

export function RemotesModal({ opened, onClose, onManage }: RemotesModalProps) {
  const t = useT();
  const remotesQuery = useQuery({ ...qRemotes(), enabled: opened });
  const [search, setSearch] = useState('');
  const repos = filterRepos(remotesQuery.data?.repos ?? [], search);

  return (
    <Modal opened={opened} onClose={onClose} title={t('remotes.title')} size={MODAL_WIDTH} centered>
      <Stack gap="sm">
        <TextInput
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          placeholder={t('remotes.search')}
          aria-label={t('remotes.search')}
          leftSection={<TbSearch size={14} />}
          rightSection={
            search ? (
              <ActionIcon
                size="sm"
                variant="subtle"
                color="gray"
                onClick={() => setSearch('')}
                aria-label={t('common.clear')}
              >
                <TbX size={14} />
              </ActionIcon>
            ) : null
          }
        />
        {remotesQuery.isLoading ? (
          <Stack gap="xs">
            <Skeleton height={72} />
            <Skeleton height={72} />
            <Skeleton height={72} />
          </Stack>
        ) : remotesQuery.isError ? (
          <ErrorState onRetry={() => remotesQuery.refetch()} message={remotesQuery.error.message} />
        ) : repos.length === 0 ? (
          <EmptyState title={t('remotes.empty')} />
        ) : (
          <Stack gap="xs">
            {repos.map((repo) => (
              <RepoCard key={repo.id} repo={repo} onManage={onManage} />
            ))}
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}
