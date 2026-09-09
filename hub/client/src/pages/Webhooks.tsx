import type { ToolId, WebhookScope } from '@hub/shared';
import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Group,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useState } from 'react';
import {
  TbBell,
  TbBrandDiscord,
  TbBrandSlack,
  TbBrandTeams,
  TbPencil,
  TbPlayerPlay,
  TbPlus,
  TbTrash,
  TbWebhook,
} from 'react-icons/tb';
import { api } from '~/api/client';
import { confirmDialog } from '~/components/confirmDialog.js';
import { EmptyState } from '~/components/EmptyState.js';
import { FormModal } from '~/components/FormModal.js';
import { PageHeader } from '~/components/PageHeader.js';
import { ListSkeleton } from '~/components/Skeletons.js';
import { toast } from '~/components/Toast';
import { useProjectList, useProjectTypes } from '~/hooks/useProjectQueries';
import { useToolOptions, useTools } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';

interface Webhook {
  id: string;
  name: string;
  platform: 'slack' | 'discord' | 'teams' | 'line' | 'generic';
  url: string;
  token?: string;
  recipientId?: string;
  events: string[];
  /** Optional run scope. Empty fields = "any". */
  scope?: WebhookScope;
  /** @deprecated legacy — server migrates into `scope` automatically. */
  projectFilter?: string[];
  enabled: boolean;
  lastTriggeredAt?: string;
  lastStatus?: 'success' | 'error';
  createdAt: string;
}

const PLATFORM_OPTIONS = [
  { value: 'slack', label: 'Slack' },
  { value: 'discord', label: 'Discord' },
  { value: 'teams', label: 'Teams' },
  { value: 'line', label: 'LINE' },
  { value: 'generic', label: 'Generic' },
];

const EVENT_OPTIONS = [
  'run-passed',
  'run-failed',
  'run-error',
  'run-cancelled',
  'schedule-triggered',
];

function platformIcon(platform: string) {
  switch (platform) {
    case 'slack':
      return <TbBrandSlack size={14} />;
    case 'discord':
      return <TbBrandDiscord size={14} />;
    case 'teams':
      return <TbBrandTeams size={14} />;
    default:
      return <TbWebhook size={14} />;
  }
}

function scopeLabel(scope?: WebhookScope): string | null {
  if (!scope) return null;
  const parts = [scope.tool, scope.type, scope.project].filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : null;
}

export function WebhooksPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [createOpen, { open: openCreate, close: closeCreate }] = useDisclosure(false);
  const [editing, setEditing] = useState<Webhook | null>(null);

  const webhooks = useQuery<Webhook[]>({
    queryKey: ['webhooks'],
    queryFn: () => api.get('/api/webhooks'),
  });

  const toggleMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/webhooks/${id}/toggle`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['webhooks'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/webhooks/${id}`),
    onSuccess: () => {
      toast.success(t('webhook.deleted'));
      queryClient.invalidateQueries({ queryKey: ['webhooks'] });
    },
  });

  const testMutation = useMutation({
    mutationFn: (w: Webhook) => {
      const params = new URLSearchParams();
      if (w.scope?.tool) params.set('tool', w.scope.tool);
      if (w.scope?.type) params.set('type', w.scope.type);
      if (w.scope?.project) params.set('project', w.scope.project);
      const qs = params.toString() ? `?${params.toString()}` : '';
      return api.post(`/api/webhooks/${w.id}/test${qs}`);
    },
    onSuccess: () => toast.success(t('webhook.testSent')),
    onError: () => toast.error(t('webhook.testFailed')),
  });

  async function handleDelete(id: string) {
    const ok = await confirmDialog({
      title: t('webhook.deleteTitle'),
      message: t('webhook.deleteConfirm'),
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) deleteMutation.mutate(id);
  }

  return (
    <Stack gap="md">
      <PageHeader
        title={t('webhooks.title')}
        description={t('settings.webhooksDesc')}
        actions={
          <Button leftSection={<TbPlus size={14} />} onClick={openCreate} size="xs">
            {t('webhooks.newWebhook')}
          </Button>
        }
      />

      {webhooks.isLoading && <ListSkeleton rows={4} />}

      {webhooks.data && webhooks.data.length === 0 && (
        <EmptyState
          icon={<TbBell size={48} color="var(--mantine-color-dimmed)" />}
          description={t('webhooks.noWebhooks')}
        />
      )}

      {webhooks.data && webhooks.data.length > 0 && (
        <Stack gap="xs">
          {webhooks.data.map((w) => {
            const scopeText = scopeLabel(w.scope);
            return (
              <Paper key={w.id} p="md" withBorder style={{ opacity: w.enabled ? 1 : 0.6 }}>
                <Group justify="space-between" wrap="wrap" gap="md">
                  <Group gap="md" wrap="nowrap">
                    <Switch
                      checked={w.enabled}
                      onChange={() => toggleMutation.mutate(w.id)}
                      size="md"
                      color="green"
                    />
                    <Stack gap={2}>
                      <Group gap="xs">
                        <Text size="sm" fw={500}>
                          {w.name}
                        </Text>
                        <Badge size="xs" variant="light" leftSection={platformIcon(w.platform)}>
                          {w.platform}
                        </Badge>
                        {scopeText ? (
                          <Tooltip label={t('webhook.scopedTooltip')}>
                            <Badge size="xs" variant="light" color="grape">
                              {scopeText}
                            </Badge>
                          </Tooltip>
                        ) : (
                          <Badge size="xs" variant="default">
                            {t('webhook.allProjects')}
                          </Badge>
                        )}
                      </Group>
                      <Text size="xs" c="dimmed" lineClamp={1}>
                        {w.platform === 'line'
                          ? `LINE → ${w.recipientId ?? '(no recipient)'}`
                          : w.url}
                      </Text>
                      <Group gap={4}>
                        {w.events.map((ev) => (
                          <Badge key={ev} size="xs" variant="dot" color="blue">
                            {ev}
                          </Badge>
                        ))}
                      </Group>
                    </Stack>
                  </Group>
                  <Group gap="xs" wrap="wrap">
                    {w.lastTriggeredAt && (
                      <Tooltip
                        label={`${t('webhook.lastPrefix')} ${dayjs(w.lastTriggeredAt).format('DD MMM HH:mm')}`}
                      >
                        <Badge
                          variant="light"
                          size="sm"
                          color={w.lastStatus === 'success' ? 'green' : 'red'}
                        >
                          {w.lastStatus === 'success' ? t('webhook.ok') : t('webhook.failed')}{' '}
                          {dayjs(w.lastTriggeredAt).fromNow()}
                        </Badge>
                      </Tooltip>
                    )}
                    <Tooltip label={t('webhook.test')}>
                      <ActionIcon
                        variant="subtle"
                        color="teal"
                        onClick={() => testMutation.mutate(w)}
                        loading={testMutation.isPending && testMutation.variables === w}
                        aria-label={t('webhook.test')}
                      >
                        <TbPlayerPlay size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <ActionIcon
                      variant="subtle"
                      color="blue"
                      onClick={() => setEditing(w)}
                      aria-label={t('webhook.edit')}
                    >
                      <TbPencil size={16} />
                    </ActionIcon>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      onClick={() => handleDelete(w.id)}
                      aria-label={t('webhook.delete')}
                    >
                      <TbTrash size={16} />
                    </ActionIcon>
                  </Group>
                </Group>
              </Paper>
            );
          })}
        </Stack>
      )}

      <WebhookFormModal
        opened={createOpen}
        onClose={closeCreate}
        onSuccess={() => {
          closeCreate();
          queryClient.invalidateQueries({ queryKey: ['webhooks'] });
        }}
      />

      <WebhookFormModal
        key={editing?.id ?? 'edit'}
        opened={!!editing}
        webhook={editing}
        onClose={() => setEditing(null)}
        onSuccess={() => {
          setEditing(null);
          queryClient.invalidateQueries({ queryKey: ['webhooks'] });
        }}
      />
    </Stack>
  );
}

function WebhookFormModal({
  opened,
  webhook,
  onClose,
  onSuccess,
}: {
  opened: boolean;
  webhook?: Webhook | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const isEdit = !!webhook;
  const t = useT();
  const [name, setName] = useState(webhook?.name ?? '');
  const [platform, setPlatform] = useState<Webhook['platform']>(webhook?.platform ?? 'slack');
  const [url, setUrl] = useState(webhook?.url ?? '');
  const [token, setToken] = useState(webhook?.token ?? '');
  const [recipientId, setRecipientId] = useState(webhook?.recipientId ?? '');
  const [events, setEvents] = useState<string[]>(webhook?.events ?? ['run-passed', 'run-failed']);

  // Scope editor — initialize from `scope`, falling back to legacy `projectFilter[0]`.
  const initialScope: WebhookScope =
    webhook?.scope ??
    (webhook?.projectFilter && webhook.projectFilter.length > 0
      ? { project: webhook.projectFilter[0] }
      : {});
  const initialScoped = !!(initialScope.tool || initialScope.type || initialScope.project);
  const [scopedToProject, setScopedToProject] = useState(initialScoped);
  const [scopeTool, setScopeTool] = useState<ToolId | ''>(
    (initialScope.tool as ToolId | undefined) ?? '',
  );
  const [scopeType, setScopeType] = useState<string>(initialScope.type ?? '');
  const [scopeProject, setScopeProject] = useState<string>(initialScope.project ?? '');
  const [enabled, setEnabled] = useState(webhook?.enabled ?? true);

  const types = useProjectTypes(scopedToProject ? scopeTool : '');
  const toolOptions = useToolOptions();
  const toolsQuery = useTools();
  const scopeToolView = (toolsQuery.data ?? []).find((tv) => tv.id === scopeTool);
  const scopeTypeAxis = scopeToolView?.projects.typeAxis ?? true;
  const scopeFixedType = scopeToolView?.projects.fixedType ?? null;

  const effectiveType = scopeTypeAxis ? scopeType : (scopeFixedType ?? '');
  const projects = useProjectList(scopedToProject ? scopeTool : '', effectiveType);

  const mutation = useMutation({
    mutationFn: () => {
      const scope: WebhookScope = scopedToProject
        ? {
            ...(scopeTool ? { tool: scopeTool as ToolId } : {}),
            ...(effectiveType ? { type: effectiveType } : {}),
            ...(scopeProject ? { project: scopeProject } : {}),
          }
        : {};

      const body: Record<string, unknown> = {
        name,
        platform,
        url: platform === 'line' ? `line://${recipientId}` : url,
        events,
        scope,
        enabled,
        ...(platform === 'line' ? { token, recipientId } : {}),
      };
      return isEdit
        ? api.put(`/api/webhooks/${webhook.id}`, body)
        : api.post('/api/webhooks', body);
    },
    onSuccess: () => {
      toast.success(isEdit ? t('webhook.updated') : t('webhook.created'));
      onSuccess();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  function toggleEvent(ev: string) {
    setEvents((prev) => (prev.includes(ev) ? prev.filter((e) => e !== ev) : [...prev, ev]));
  }

  function onScopedToggle(next: boolean) {
    setScopedToProject(next);
    if (!next) {
      setScopeTool('');
      setScopeType('');
      setScopeProject('');
    }
  }

  function onToolChange(next: ToolId | '') {
    setScopeTool(next);
    // Reset downstream — k6 forces type, others clear it
    const nextView = (toolsQuery.data ?? []).find((tv) => tv.id === next);
    const nextTypeAxis = nextView?.projects.typeAxis ?? true;
    setScopeType(nextTypeAxis ? '' : (nextView?.projects.fixedType ?? ''));
    setScopeProject('');
  }

  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title={isEdit ? t('webhook.editTitle') : t('webhooks.newWebhook')}
      size="md"
      submitLabel={isEdit ? t('common.save') : t('common.create')}
      onSubmit={() => mutation.mutate()}
      submitDisabled={
        !name || (platform === 'line' ? !token || !recipientId : !url) || events.length === 0
      }
      loading={mutation.isPending}
    >
      <TextInput
        label={t('webhook.name')}
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        placeholder="CI Notifications"
      />
      <Select
        label={t('webhook.platform')}
        value={platform}
        onChange={(v) => v && setPlatform(v as Webhook['platform'])}
        data={PLATFORM_OPTIONS}
        allowDeselect={false}
      />
      <TextInput
        label={t('webhook.url')}
        value={url}
        onChange={(e) => setUrl(e.currentTarget.value)}
        placeholder={
          platform === 'slack'
            ? 'https://hooks.slack.com/services/...'
            : platform === 'discord'
              ? 'https://discord.com/api/webhooks/...'
              : platform === 'teams'
                ? 'https://outlook.office.com/webhook/...'
                : 'https://...'
        }
        disabled={platform === 'line'}
        description={platform === 'line' ? t('webhook.lineNoUrl') : undefined}
      />
      {platform === 'line' && (
        <>
          <TextInput
            label={t('webhook.token')}
            value={token}
            onChange={(e) => setToken(e.currentTarget.value)}
            placeholder={t('webhooks.lineTokenPlaceholder')}
            description={t('webhook.tokenDesc')}
          />
          <TextInput
            label={t('webhook.recipient')}
            value={recipientId}
            onChange={(e) => setRecipientId(e.currentTarget.value)}
            placeholder={t('webhooks.lineTargetPlaceholder')}
            description={t('webhook.recipientDesc')}
          />
        </>
      )}
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          {t('webhook.events')}
        </Text>
        <Group gap="xs">
          {EVENT_OPTIONS.map((ev) => (
            <Checkbox
              key={ev}
              label={ev}
              size="xs"
              checked={events.includes(ev)}
              onChange={() => toggleEvent(ev)}
            />
          ))}
        </Group>
      </Stack>

      <Paper withBorder p="sm" radius="sm">
        <Stack gap="sm">
          <Switch
            label={t('webhook.filterByProject')}
            description={t('webhook.filterByProjectDesc')}
            checked={scopedToProject}
            onChange={(e) => onScopedToggle(e.currentTarget.checked)}
          />
          {scopedToProject && (
            <Stack gap="xs">
              <Select
                label={t('run.tool')}
                value={scopeTool || null}
                onChange={(v) => onToolChange((v as ToolId | null) ?? '')}
                data={toolOptions}
                placeholder={t('webhook.selectTool')}
                clearable
              />
              {scopeTool && scopeTypeAxis && (
                <Select
                  label={t('run.type')}
                  value={scopeType || null}
                  onChange={(v) => {
                    setScopeType(v ?? '');
                    setScopeProject('');
                  }}
                  data={types.data ?? []}
                  placeholder={types.isFetching ? t('common.loading') : t('webhook.selectType')}
                  disabled={!types.data || types.data.length === 0}
                  clearable
                />
              )}
              {scopeTool && (
                <Select
                  label={t('run.project')}
                  value={scopeProject || null}
                  onChange={(v) => setScopeProject(v ?? '')}
                  data={projects.data ?? []}
                  placeholder={
                    projects.isFetching
                      ? t('common.loading')
                      : !effectiveType
                        ? t('webhook.selectTypeFirst')
                        : t('webhook.selectProject')
                  }
                  disabled={!effectiveType || !projects.data}
                  searchable
                  clearable
                />
              )}
              <Text size="xs" c="dimmed">
                {t('webhook.scopeTip')}
              </Text>
            </Stack>
          )}
        </Stack>
      </Paper>

      <Switch
        label={t('webhook.enabled')}
        checked={enabled}
        onChange={(e) => setEnabled(e.currentTarget.checked)}
      />
    </FormModal>
  );
}
