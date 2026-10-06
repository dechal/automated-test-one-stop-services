import type { EnvProfile } from '@hub/shared';
import {
  ActionIcon,
  Badge,
  Button,
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
import { useEffect, useState } from 'react';
import {
  TbCheck,
  TbDownload,
  TbKey,
  TbPencil,
  TbPlayerPlay,
  TbPlus,
  TbStar,
  TbStarFilled,
  TbTrash,
} from 'react-icons/tb';
import { api } from '~/api/client.js';
import { qEnvProfilesByProject } from '~/api/queries.js';
import { confirmDialog } from '~/components/confirmDialog.js';
import { EmptyState } from '~/components/EmptyState.js';
import { FormModal } from '~/components/FormModal.js';
import { InlineAlert } from '~/components/InlineAlert.js';
import { ListSkeleton } from '~/components/Skeletons.js';
import { toast } from '~/components/Toast';
import { useT } from '~/i18n/index.js';
import { ENV_OPTIONS, envColor } from '~/utils/env-options.js';

interface EnvProfileManagerProps {
  /** The project axis is fixed by the host (run form or EnvProfiles page). */
  tool: string;
  type: string;
  project: string;
}

/**
 * The list + create/edit/capture/apply/default/switch surface for one project's
 * env profiles. Shared by the EnvProfiles page (behind a cascading selector)
 * and the run-page Drawer, so both read the SAME `['env-profiles', …]` cache.
 */
export function EnvProfileManager({ tool, type, project }: EnvProfileManagerProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const [createOpen, { open: openCreate, close: closeCreate }] = useDisclosure(false);
  const [editing, setEditing] = useState<EnvProfile | null>(null);
  const [captureOpen, { open: openCapture, close: closeCapture }] = useDisclosure(false);

  const profiles = useQuery(qEnvProfilesByProject(tool, type, project));

  const activeProfile = useQuery<{ activeId: string | null }>({
    queryKey: ['env-profiles-active', tool, type, project],
    queryFn: () => api.get(`/api/env-profiles/active?tool=${tool}&type=${type}&project=${project}`),
    enabled: !!tool && !!type && !!project,
  });

  const defaultProfile = useQuery<{ defaultId: string | null }>({
    queryKey: ['env-profiles-default', tool, type, project],
    queryFn: () =>
      api.get(`/api/env-profiles/default?tool=${tool}&type=${type}&project=${project}`),
    enabled: !!tool && !!type && !!project,
  });

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ['env-profiles', tool, type, project] });
    queryClient.invalidateQueries({ queryKey: ['env-profiles-default', tool, type, project] });
    queryClient.invalidateQueries({ queryKey: ['env-profiles-active', tool, type, project] });
  }

  const applyMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/env-profiles/${id}/apply`),
    onSuccess: () => {
      toast.success(t('envProfiles.applied'));
      queryClient.invalidateQueries({ queryKey: ['env-profiles-active', tool, type, project] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const defaultMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/env-profiles/${id}/default`),
    onSuccess: () => invalidateAll(),
    onError: (err) => toast.error((err as Error).message),
  });

  const allowOutsideMutation = useMutation({
    mutationFn: ({ id, allow }: { id: string; allow: boolean }) =>
      api.put(`/api/env-profiles/${id}`, { allowOutsideTemplate: allow }),
    onSuccess: () => invalidateAll(),
    onError: (err) => toast.error((err as Error).message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/env-profiles/${id}`),
    onSuccess: () => {
      toast.success(t('envProfiles.deleted'));
      invalidateAll();
    },
  });

  async function handleDelete(id: string) {
    const ok = await confirmDialog({
      title: t('envProfiles.deleteTitle'),
      message: t('envProfiles.deleteConfirm'),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (ok) deleteMutation.mutate(id);
  }

  return (
    <Stack gap="md">
      <Group justify="flex-end" gap="xs">
        <Button
          variant="light"
          size="xs"
          onClick={openCapture}
          disabled={!project}
          leftSection={<TbKey size={14} />}
        >
          {t('envProfiles.captureCurrentEnv')}
        </Button>
        <Button
          leftSection={<TbPlus size={14} />}
          onClick={openCreate}
          size="xs"
          disabled={!project}
        >
          {t('envProfiles.newProfile')}
        </Button>
      </Group>

      {profiles.isLoading && !!project && <ListSkeleton rows={3} />}

      {!project && <EmptyState description={t('envProfiles.selectProject')} />}

      {profiles.data && profiles.data.length === 0 && (
        <EmptyState
          icon={<TbKey size={48} color="var(--mantine-color-dimmed)" />}
          description={t('envProfiles.noProfiles')}
        />
      )}

      {profiles.data && profiles.data.length > 0 && (
        <Stack gap="xs">
          {profiles.data.map((p) => {
            const isActive = activeProfile.data?.activeId === p.id;
            const isDefault = defaultProfile.data?.defaultId === p.id;
            return (
              <Paper key={p.id} p="md" withBorder>
                <Group justify="space-between" wrap="wrap" gap="md">
                  <Stack gap={2}>
                    <Group gap="xs">
                      <Text size="sm" fw={500}>
                        {p.name}
                      </Text>
                      <Badge size="xs" variant="light" color={envColor(p.environment)}>
                        {p.environment}
                      </Badge>
                      {isDefault && (
                        <Badge
                          size="xs"
                          variant="light"
                          color="yellow"
                          leftSection={<TbStarFilled size={10} />}
                        >
                          {t('envProfiles.isDefault')}
                        </Badge>
                      )}
                      {isActive && (
                        <Badge
                          size="xs"
                          variant="filled"
                          color="green"
                          leftSection={<TbCheck size={10} />}
                        >
                          {t('common.active')}
                        </Badge>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed">
                      {Object.keys(p.entries).length} keys · Updated {dayjs(p.updatedAt).fromNow()}
                    </Text>
                    <Switch
                      mt={6}
                      size="xs"
                      label={t('envProfiles.allowOutside')}
                      checked={p.allowOutsideTemplate ?? false}
                      onChange={(e) =>
                        allowOutsideMutation.mutate({ id: p.id, allow: e.currentTarget.checked })
                      }
                    />
                  </Stack>
                  <Group gap="xs">
                    <Tooltip label={t('envProfiles.setDefault')}>
                      <ActionIcon
                        variant="subtle"
                        color="yellow"
                        onClick={() => defaultMutation.mutate(p.id)}
                        disabled={isDefault}
                        aria-label={t('envProfiles.setDefault')}
                      >
                        {isDefault ? <TbStarFilled size={16} /> : <TbStar size={16} />}
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label={t('envProfiles.applyTooltip')}>
                      <Button
                        size="xs"
                        variant="light"
                        color="green"
                        leftSection={<TbPlayerPlay size={14} />}
                        onClick={() => applyMutation.mutate(p.id)}
                        loading={applyMutation.isPending && applyMutation.variables === p.id}
                      >
                        {t('envProfiles.apply')}
                      </Button>
                    </Tooltip>
                    <ActionIcon
                      variant="subtle"
                      color="blue"
                      onClick={() => setEditing(p)}
                      aria-label={t('envProfiles.editProfile')}
                    >
                      <TbPencil size={16} />
                    </ActionIcon>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      onClick={() => handleDelete(p.id)}
                      aria-label={t('envProfiles.deleteProfile')}
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

      <ProfileFormModal
        opened={createOpen}
        onClose={closeCreate}
        tool={tool}
        type={type}
        project={project}
        onSuccess={() => {
          closeCreate();
          invalidateAll();
        }}
      />

      <ProfileFormModal
        key={editing?.id ?? 'edit'}
        opened={!!editing}
        profile={editing}
        tool={tool}
        type={type}
        project={project}
        onClose={() => setEditing(null)}
        onSuccess={() => {
          setEditing(null);
          invalidateAll();
        }}
      />

      <CaptureModal
        opened={captureOpen}
        onClose={closeCapture}
        tool={tool}
        type={type}
        project={project}
        onSuccess={() => {
          closeCapture();
          invalidateAll();
        }}
      />
    </Stack>
  );
}

function ProfileFormModal({
  opened,
  profile,
  tool,
  type,
  project,
  onClose,
  onSuccess,
}: {
  opened: boolean;
  profile?: EnvProfile | null;
  tool: string;
  type: string;
  project: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const isEdit = !!profile;
  const t = useT();
  const [name, setName] = useState(profile?.name ?? '');
  const [environment, setEnvironment] = useState(profile?.environment ?? 'dev');
  const [allowOutside, setAllowOutside] = useState(profile?.allowOutsideTemplate ?? false);
  const [rows, setRows] = useState<Array<{ key: string; value: string }>>(
    profile
      ? Object.entries(profile.entries).map(([key, value]) => ({ key, value }))
      : [{ key: '', value: '' }],
  );

  useEffect(() => {
    setName(profile?.name ?? '');
    setEnvironment(profile?.environment ?? 'dev');
    setAllowOutside(profile?.allowOutsideTemplate ?? false);
    setRows(
      profile
        ? Object.entries(profile.entries).map(([key, value]) => ({ key, value }))
        : [{ key: '', value: '' }],
    );
  }, [profile]);

  // Template drives both the pre-fill button and the live key-sync feedback, so
  // it is fetched whenever the modal is open (not only for create).
  const template = useQuery<Record<string, string>>({
    queryKey: ['env-profiles-template', tool, type, project],
    queryFn: () =>
      api.get(`/api/env-profiles/template?tool=${tool}&type=${type}&project=${project}`),
    enabled: !!tool && !!type && !!project && opened,
  });

  // Key-sync feedback mirrors the server's validate(): missing keys warn,
  // extra keys gate on the allow-outside switch.
  const templateKeys = Object.keys(template.data ?? {});
  const hasTemplate = templateKeys.length > 0;
  const profileKeys = rows.map((r) => r.key.trim()).filter(Boolean);
  const missingKeys = hasTemplate ? templateKeys.filter((k) => !profileKeys.includes(k)) : [];
  const extraKeys = hasTemplate ? profileKeys.filter((k) => !templateKeys.includes(k)) : [];
  const extraBlocked = !allowOutside && extraKeys.length > 0;

  function loadFromTemplate() {
    if (!template.data) return;
    const templateRows = Object.entries(template.data).map(([key, value]) => ({ key, value }));
    if (templateRows.length === 0) {
      toast.info(t('envProfiles.templateEmpty'));
      return;
    }
    setRows(templateRows);
    toast.success(`${templateRows.length} ${t('envProfiles.keysFromTemplate')}`);
  }

  function addRow() {
    setRows((prev) => [...prev, { key: '', value: '' }]);
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  function updateRow(index: number, field: 'key' | 'value', val: string) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: val } : r)));
  }

  const mutation = useMutation({
    mutationFn: () => {
      const entries: Record<string, string> = {};
      for (const row of rows) {
        if (row.key.trim()) entries[row.key.trim()] = row.value;
      }
      const body = {
        name,
        environment,
        tool,
        type,
        project,
        entries,
        allowOutsideTemplate: allowOutside,
      };
      return isEdit
        ? api.put(`/api/env-profiles/${profile.id}`, body)
        : api.post('/api/env-profiles', body);
    },
    onSuccess: () => {
      toast.success(isEdit ? t('envProfiles.profileUpdated') : t('envProfiles.profileCreated'));
      onSuccess();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title={isEdit ? t('envProfiles.editProfileTitle') : t('envProfiles.newProfile')}
      size="lg"
      submitLabel={isEdit ? t('common.save') : t('common.create')}
      onSubmit={() => mutation.mutate()}
      submitDisabled={!name || extraBlocked}
      loading={mutation.isPending}
    >
      <TextInput
        label={t('webhook.name')}
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        placeholder="Production API keys"
      />
      <Select
        label={t('envProfiles.environment')}
        value={environment}
        onChange={(v) => v && setEnvironment(v)}
        data={ENV_OPTIONS}
        allowDeselect={false}
      />

      <Switch
        label={t('envProfiles.allowOutside')}
        checked={allowOutside}
        onChange={(e) => setAllowOutside(e.currentTarget.checked)}
      />

      {missingKeys.length > 0 && (
        <InlineAlert
          color="yellow"
          icon={<TbKey size={14} />}
          message={`${t('envProfiles.missingKeys')}: ${missingKeys.join(', ')}`}
        />
      )}
      {extraKeys.length > 0 && (
        <InlineAlert
          color={allowOutside ? 'gray' : 'red'}
          icon={<TbKey size={14} />}
          message={`${allowOutside ? t('envProfiles.extraKeysAllowed') : t('envProfiles.extraKeysBlocked')}: ${extraKeys.join(', ')}`}
        />
      )}

      <Stack gap={4}>
        <Group justify="space-between" align="center">
          <Text size="sm" fw={500}>
            {t('envProfiles.entries')}
          </Text>
          {!isEdit && (
            <Button
              size="xs"
              variant="subtle"
              leftSection={<TbDownload size={12} />}
              onClick={loadFromTemplate}
              loading={template.isLoading}
              disabled={!template.data || Object.keys(template.data).length === 0}
            >
              {t('envProfiles.loadFromTemplate')}
            </Button>
          )}
        </Group>
        {rows.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: dynamic form rows without stable IDs
          <Group key={i} gap="xs" wrap="nowrap">
            <TextInput
              size="xs"
              placeholder="KEY"
              value={row.key}
              onChange={(e) => updateRow(i, 'key', e.currentTarget.value)}
              style={{ flex: 1 }}
              styles={{ input: { fontFamily: 'monospace' } }}
            />
            <TextInput
              size="xs"
              placeholder="value"
              value={row.value}
              onChange={(e) => updateRow(i, 'value', e.currentTarget.value)}
              style={{ flex: 2 }}
              styles={{ input: { fontFamily: 'monospace' } }}
            />
            <ActionIcon
              variant="subtle"
              color="red"
              size="sm"
              onClick={() => removeRow(i)}
              disabled={rows.length <= 1}
              aria-label={t('envProfiles.removeRow')}
            >
              <TbTrash size={14} />
            </ActionIcon>
          </Group>
        ))}
        <Button size="xs" variant="light" onClick={addRow} leftSection={<TbPlus size={12} />}>
          {t('env.addEntry')}
        </Button>
      </Stack>
    </FormModal>
  );
}

function CaptureModal({
  opened,
  onClose,
  tool,
  type,
  project,
  onSuccess,
}: {
  opened: boolean;
  onClose: () => void;
  tool: string;
  type: string;
  project: string;
  onSuccess: () => void;
}) {
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState('dev');
  const t = useT();

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/api/env-profiles/capture', { tool, type, project, name, environment }),
    onSuccess: () => {
      toast.success(t('envProfiles.captured'));
      setName('');
      onSuccess();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title={t('envProfiles.captureTitle')}
      size="sm"
      submitLabel={t('envProfiles.capture')}
      onSubmit={() => mutation.mutate()}
      submitDisabled={!name}
      loading={mutation.isPending}
    >
      <TextInput
        label={t('envProfiles.profileName')}
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        placeholder="Current dev snapshot"
      />
      <Select
        label={t('envProfiles.environment')}
        value={environment}
        onChange={(v) => v && setEnvironment(v)}
        data={ENV_OPTIONS}
        allowDeselect={false}
      />
    </FormModal>
  );
}
