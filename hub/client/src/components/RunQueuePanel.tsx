import type { QueueStatus } from '@hub/shared';
import { ActionIcon, Badge, Group, Stack, Text, Tooltip } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useState } from 'react';
import { TbArrowUp, TbPlayerPlay, TbX } from 'react-icons/tb';
import { api } from '~/api/client';
import { CollapsibleCard } from '~/components/CollapsibleCard.js';
import { toast } from '~/components/Toast';
import { useTools } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';
import { toolLabel } from '~/utils/tool-label.js';

/** Poll fast while something is happening, slow when the queue is idle. */
const POLL_ACTIVE_MS = 3000;
const POLL_IDLE_MS = 30_000;

export function RunQueuePanel() {
  const t = useT();
  // Collapsed by default: the always-visible header already shows the
  // running/queued counts; expand only when you want the per-run detail. Keeps
  // the run form + live output as the focus during an active run.
  const [expanded, setExpanded] = useState(false);
  const tools = useTools();
  const queryClient = useQueryClient();

  const queue = useQuery<QueueStatus>({
    queryKey: ['queue'],
    queryFn: () => api.get('/api/queue'),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && (data.activeCount > 0 || data.queueLength > 0) ? POLL_ACTIVE_MS : POLL_IDLE_MS;
    },
  });

  const refreshQueue = () => queryClient.invalidateQueries({ queryKey: ['queue'] });

  const promote = useMutation({
    mutationFn: (id: string) => api.post(`/api/queue/promote/${id}`),
    onSuccess: () => {
      toast.success(t('queue.promoted'));
      refreshQueue();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/queue/${id}`),
    onSuccess: () => {
      toast.success(t('queue.removed'));
      refreshQueue();
    },
  });

  const activeCount = queue.data?.activeCount ?? 0;
  const queueLength = queue.data?.queueLength ?? 0;
  const maxConcurrency = queue.data?.maxConcurrency ?? 2;
  const queued = queue.data?.queued ?? [];

  if (!queue.data || (activeCount === 0 && queueLength === 0)) {
    return null;
  }

  return (
    <CollapsibleCard
      icon={<TbPlayerPlay size={16} color="var(--mantine-color-blue-6)" />}
      title={t('queue.title')}
      open={expanded}
      onToggle={() => setExpanded((v) => !v)}
      style={{ flexShrink: 0 }}
      actions={
        <>
          <Badge size="xs" color="blue" variant="light">
            {activeCount}/{maxConcurrency} {t('common.running').toLowerCase()}
          </Badge>
          {queueLength > 0 && (
            <Badge size="xs" color="orange" variant="light">
              {queueLength} {t('settings.queued')}
            </Badge>
          )}
        </>
      }
    >
      <Stack gap={4} mt="xs" px="xs">
        {(queue.data?.active ?? []).map((run) => (
          <Group key={run.id} justify="space-between" gap="xs" wrap="nowrap">
            <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
              <Badge size="xs" variant="filled" color="blue">
                {t('common.running')}
              </Badge>
              <Text size="xs" fw={500} truncate>
                {run.request.project}
              </Text>
              <Badge size="xs" variant="light" color="gray">
                {toolLabel(run.request.tool, tools.data ?? [])}
              </Badge>
            </Group>
            <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
              {dayjs(run.startedAt).format('HH:mm')}
            </Text>
          </Group>
        ))}

        {/* Waiting runs — named and actionable, so nobody has to guess what is
            in the queue or wait for a slot they no longer need. */}
        {queued.map((run, index) => (
          <Group key={run.id} justify="space-between" gap="xs" wrap="nowrap">
            <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
              <Badge size="xs" variant="light" color="orange">
                {index + 1}
              </Badge>
              <Text size="xs" fw={500} truncate>
                {run.request.project}
              </Text>
              <Badge size="xs" variant="light" color="gray">
                {toolLabel(run.request.tool, tools.data ?? [])}
              </Badge>
              <Text size="xs" c="dimmed">
                {t('queue.waiting')}
              </Text>
            </Group>
            <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
              {index > 0 && (
                <Tooltip label={t('queue.promote')} withArrow openDelay={300}>
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    aria-label={t('queue.promote')}
                    loading={promote.isPending && promote.variables === run.id}
                    onClick={() => promote.mutate(run.id)}
                  >
                    <TbArrowUp size={14} />
                  </ActionIcon>
                </Tooltip>
              )}
              <Tooltip label={t('queue.remove')} withArrow openDelay={300}>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="red"
                  aria-label={t('queue.remove')}
                  loading={remove.isPending && remove.variables === run.id}
                  onClick={() => remove.mutate(run.id)}
                >
                  <TbX size={14} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </Group>
        ))}

        {queueLength > 0 && (
          <Text size="xs" c="dimmed" mt={2}>
            {t('queue.hint')}
          </Text>
        )}
      </Stack>
    </CollapsibleCard>
  );
}
