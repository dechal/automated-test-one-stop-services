import type { EnvFile, ProjectSummary, ToolId } from '@hub/shared';
import {
  Button,
  Group,
  Indicator,
  Loader,
  Paper,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { TbDownload, TbPlus, TbPuzzle } from 'react-icons/tb';
import { api } from '~/api/client.js';
import { ErrorState } from '~/components/ErrorState.js';
import { PageHeader } from '~/components/PageHeader.js';
import { AddToolsModal } from '~/components/projects/AddToolsModal.js';
import { CloneModal } from '~/components/projects/CloneModal.js';
import { CreateModal } from '~/components/projects/CreateModal.js';
import {
  type EnvEntry,
  EnvModal,
  type EnvModalEditingTarget,
} from '~/components/projects/EnvModal.js';
import { ProjectRow } from '~/components/projects/ProjectRow.js';
import { ToolSection } from '~/components/projects/ToolSection.js';
import { ToolSectionActions } from '~/components/projects/ToolSectionActions.js';
import { UsageLoggingSetup } from '~/components/projects/UsageLoggingSetup.js';
import { toast } from '~/components/Toast.js';
import { TypeToConfirmModal } from '~/components/TypeToConfirmModal.js';
import { useTools } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';

interface PullResult {
  project: string;
  tool: string;
  type: string;
  success: boolean;
  output: string;
}

interface PullAllStatus {
  running: boolean;
  stage:
    | 'idle'
    | 'pulling'
    | 'building-shared'
    | 'building-client'
    | 'building-server'
    | 'restarting'
    | 'done';
  error?: string;
  results: PullResult[];
  rebuilt: boolean;
  restarted: boolean;
  finishedAt?: string;
}

/**
 * Poll /api/health until it succeeds or timeout. Used during pull-all
 * to detect when the server is back online after a Hub restart.
 */
async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (res.ok) return true;
    } catch {
      // server still down; ignore
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

interface GitStatusItem {
  project: string;
  tool: string;
  type: string;
  branch: string;
  localHash: string;
  remoteHash: string;
  hasUpdate: boolean;
  error?: string;
}

interface GitStatusResponse {
  items: GitStatusItem[];
  anyUpdate: boolean;
}

type EditingEnv = (EnvModalEditingTarget & { tool: ToolId | 'scripts' }) | null;

/**
 * Project Manager page.
 *
 * Lists every project the hub knows about (grouped by tool/type) plus a
 * scripts/.env entry, and exposes the lifecycle operations:
 *  - Create: scaffold a new project from the workspace template.
 *  - Clone: pull an existing repository into the right path.
 *  - Pull / Pull All: refresh local working trees from their remotes.
 *  - .env editor: edit per-project environment variables.
 *
 * The heavy UI pieces (ToolSection / ProjectRow / EnvModal / CreateModal /
 * CloneModal) live in `~/components/projects/` so this page stays focused
 * on data orchestration.
 */
export function ProjectsPage() {
  const queryClient = useQueryClient();
  const t = useT();
  const [createOpen, { open: openCreate, close: closeCreate }] = useDisclosure(false);
  const [cloneOpen, { open: openClone, close: closeClone }] = useDisclosure(false);
  const [addToolsOpen, { open: openAddTools, close: closeAddTools }] = useDisclosure(false);
  const [cloneTool, setCloneTool] = useState<ToolId | undefined>(undefined);
  // Sections expanded by default: `scripts` plus every installed tool. Seeded
  // once from `useTools()` (below) so portable tools expand by default too,
  // without re-expanding sections the user later collapses.
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set(['scripts']));
  const [editingEnv, setEditingEnv] = useState<EditingEnv>(null);
  const [editEntries, setEditEntries] = useState<EnvEntry[]>([]);
  const [removeTarget, setRemoveTarget] = useState<ProjectSummary | null>(null);

  const tools = useTools();

  // Seed the default-expanded set once, the first time the installed tools
  // resolve. Subsequent refetches won't override the user's collapse choices.
  const seededExpanded = useRef(false);
  useEffect(() => {
    if (seededExpanded.current || !tools.data) return;
    seededExpanded.current = true;
    setExpandedTools(new Set(['scripts', ...tools.data.map((t) => t.id)]));
  }, [tools.data]);
  const projects = useQuery<ProjectSummary[]>({
    queryKey: ['projects'],
    queryFn: () => api.get('/api/projects'),
  });

  const lastRunStatus = useQuery<Record<string, { status: string; endedAt: string }>>({
    queryKey: ['runs-last-status'],
    queryFn: () => api.get('/api/runs/last-status'),
  });

  // Remove a project + cascade-clean everything tied to it. The confirm string
  // is `tool/type/project`; the modal only enables its button on an exact match,
  // and the server re-validates the same string.
  const removeProjectMutation = useMutation({
    mutationFn: (p: ProjectSummary) =>
      api.post('/api/projects/remove', {
        tool: p.tool,
        type: p.type,
        project: p.name,
        confirm: `${p.tool}/${p.type}/${p.name}`,
      }),
    onSuccess: () => {
      toast.success(t('projects.removed'));
      setRemoveTarget(null);
      for (const key of [
        ['projects'],
        ['tools'],
        ['runs-last-status'],
        ['runs-history'],
        ['bookmarks'],
        ['schedules'],
        ['webhooks'],
        ['env-profiles'],
        ['artifacts'],
        ['git-status'],
      ]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : t('projects.removeFailed')),
  });

  const gitStatus = useQuery<GitStatusResponse>({
    queryKey: ['git-status'],
    queryFn: () => api.get('/api/git/status'),
    // Refresh every 5 minutes; caller can also manually invalidate after pulls.
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

  const updateLookup = new Map<string, boolean>();
  for (const item of gitStatus.data?.items ?? []) {
    updateLookup.set(`${item.tool}/${item.type}/${item.project}`, item.hasUpdate);
  }
  const anyUpdate = gitStatus.data?.anyUpdate ?? false;

  const pullAllMutation = useMutation<void>({
    mutationFn: async () => {
      // 1. Kick off pull-all (returns 202 immediately)
      await api.post('/api/git/pull-all');

      // 2. Poll /api/git/pull-all/status until done or restarting
      const timeoutMs = 120_000;
      const start = Date.now();
      let status: PullAllStatus = {
        running: true,
        stage: 'pulling',
        results: [],
        rebuilt: false,
        restarted: false,
      };

      while (Date.now() - start < timeoutMs) {
        try {
          status = await api.get<PullAllStatus>('/api/git/pull-all/status');
          if (!status.running) break;
          if (status.stage === 'restarting') break;
        } catch {
          // server bouncing during restart — fall through to waitForHealth
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      // 3. If restarted, wait for server to come back
      if (status.restarted || status.stage === 'restarting') {
        toast.info(t('projects.hubRestarting'));
        const healthy = await waitForHealth(60_000);
        if (healthy) {
          toast.success(t('projects.hubRestarted'));
        } else {
          toast.error(t('projects.hubRestartTimeout'));
        }
        return;
      }

      // 4. Report results
      if (status.error) {
        toast.error(`Pull-all error: ${status.error}`);
        return;
      }

      const hubRebuild = status.results.find((r) => r.project === '(hub-rebuild)');
      const pullResults = status.results.filter((r) => r.project !== '(hub-rebuild)');
      const failed = pullResults.filter((r) => !r.success);

      if (failed.length === 0) {
        toast.success(`Pulled ${pullResults.length} project(s) successfully`);
      } else {
        toast.error(
          `${failed.length}/${pullResults.length} pull(s) failed: ${failed.map((f) => f.project).join(', ')}`,
        );
      }

      if (hubRebuild && !hubRebuild.success) {
        toast.error(`Update Hub failed: build error — ${hubRebuild.output}`);
      } else if (hubRebuild?.success) {
        toast.success(t('projects.hubRebuilt'));
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['git-status'] });
    },
    onError: () => toast.error(t('projects.pullAllFailed')),
  });

  const [pullingProject, setPullingProject] = useState<string | null>(null);
  const pullOneMutation = useMutation<
    PullResult,
    Error,
    { tool: string; type: string; project: string }
  >({
    mutationFn: (payload) => api.post('/api/git/pull', payload),
    onMutate: (payload) => setPullingProject(`${payload.tool}/${payload.type}/${payload.project}`),
    onSuccess: (data) => {
      setPullingProject(null);
      if (data.success) toast.success(`Pulled ${data.project}`);
      else toast.error(`Pull failed: ${data.project} — ${data.output}`);
      queryClient.invalidateQueries({ queryKey: ['git-status'] });
    },
    onError: () => {
      setPullingProject(null);
      toast.error(t('projects.pullFailed'));
    },
  });

  const envQuery = useQuery<EnvFile>({
    queryKey: ['env', editingEnv],
    queryFn: () => {
      if (!editingEnv)
        return Promise.resolve({
          path: '',
          exists: false,
          hasTemplate: false,
          entries: [],
          missingKeys: [],
        });
      if (editingEnv.tool === 'scripts') return api.get('/api/env/scripts');
      return api.get(
        `/api/env/project?tool=${editingEnv.tool}&type=${editingEnv.type}&project=${editingEnv.project}`,
      );
    },
    enabled: !!editingEnv,
  });

  const saveMutation = useMutation({
    mutationFn: () => {
      const entries = editEntries.map((e) => ({ key: e.key, value: e.value, fromTemplate: false }));
      if (!editingEnv) return Promise.resolve();
      if (editingEnv.tool === 'scripts') return api.put('/api/env/scripts', { entries });
      return api.put('/api/env/project', {
        tool: editingEnv.tool,
        type: editingEnv.type,
        project: editingEnv.project,
        entries,
      });
    },
    onSuccess: () => {
      toast.success(t('projects.envSaved'));
      setEditingEnv(null);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['env'] });
      // Editing scripts/.env (SPREADSHEET_ID / FORCE_TRACK) changes usage-logging
      // readiness — refresh its badge/toggle too.
      queryClient.invalidateQueries({ queryKey: ['usage-logging'] });
    },
    onError: () => toast.error(t('projects.envSaveFailed')),
  });

  function toggleTool(id: string) {
    setExpandedTools((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function openCloneFor(toolId: ToolId) {
    setCloneTool(toolId);
    openClone();
  }

  function startEditEnv(tool: ToolId | 'scripts', type: string, project: string) {
    setEditEntries([]);
    setEditingEnv({ tool, type, project });
  }

  function populateEntries() {
    if (envQuery.data) {
      setEditEntries(envQuery.data.entries.map((e) => ({ key: e.key, value: e.value })));
    }
  }

  // Group projects by tool then by type for stable rendering.
  const grouped = new Map<ToolId, Map<string, ProjectSummary[]>>();
  for (const p of projects.data ?? []) {
    if (!grouped.has(p.tool)) grouped.set(p.tool, new Map());
    const tm = grouped.get(p.tool);
    if (!tm) continue;
    if (!tm.has(p.type)) tm.set(p.type, []);
    tm.get(p.type)?.push(p);
  }

  return (
    <Stack gap="md">
      <PageHeader
        title={t('projects.title')}
        description={t('nav.projects.desc')}
        actions={
          <>
            <Button
              leftSection={<TbPlus size={14} />}
              size="xs"
              onClick={openCreate}
              disabled={projects.isLoading}
            >
              {t('common.create')}
            </Button>
            <Button
              leftSection={<TbPuzzle size={14} />}
              variant="default"
              size="xs"
              onClick={openAddTools}
            >
              {t('projects.addTools')}
            </Button>
            <Indicator
              color="red"
              size={16}
              offset={4}
              disabled={!anyUpdate || gitStatus.isLoading}
              processing
              withBorder
            >
              <Button
                leftSection={<TbDownload size={14} />}
                variant="light"
                color="grape"
                size="xs"
                onClick={() => pullAllMutation.mutate()}
                loading={pullAllMutation.isPending}
                disabled={projects.isLoading}
              >
                {t('projects.pullAll')}
              </Button>
            </Indicator>
          </>
        }
      />

      {projects.isLoading && (
        <Stack gap="xs">
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="sm" c="dimmed">
              {t('projects.loading')}
            </Text>
          </Group>
          {[1, 2, 3].map((i) => (
            <Paper key={i} withBorder p="md">
              <Skeleton height={18} width="40%" mb="sm" />
              <Stack gap={6}>
                <Skeleton height={32} radius="sm" />
                <Skeleton height={32} radius="sm" />
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}

      {projects.isError && <ErrorState onRetry={() => projects.refetch()} />}

      {!projects.isLoading && !projects.isError && (
        <>
          <ToolSection
            label="scripts/.env"
            expanded={expandedTools.has('scripts')}
            onToggle={() => toggleTool('scripts')}
          >
            <ProjectRow
              name="scripts/.env"
              status="ready"
              onEdit={() => startEditEnv('scripts', '', '')}
            />
            <UsageLoggingSetup />
          </ToolSection>

          {/* Tool sections flow into two columns on desktop (left/right),
              single column on smaller screens. `alignItems: start` stops short
              sections from stretching to match a taller neighbour. */}
          <SimpleGrid
            cols={{ base: 1, lg: 2 }}
            spacing="md"
            verticalSpacing="md"
            style={{ alignItems: 'start' }}
          >
            {(tools.data ?? []).map((tool) => {
              const toolId = tool.id as ToolId;
              const typeMap = grouped.get(toolId);
              return (
                <ToolSection
                  key={tool.id}
                  label={tool.title}
                  expanded={expandedTools.has(tool.id)}
                  onToggle={() => toggleTool(tool.id)}
                  headerRight={
                    <ToolSectionActions tool={tool} onCloneProject={() => openCloneFor(toolId)} />
                  }
                >
                  {!typeMap || typeMap.size === 0 ? (
                    <Text size="xs" c="dimmed" px={4}>
                      {t('projects.emptyTool')}
                    </Text>
                  ) : (
                    [...typeMap.entries()].map(([type, projs]) => (
                      <Stack gap={4} key={type} mb="xs">
                        <Text size="xs" c="dimmed" fw={600} tt="uppercase" px={4}>
                          {type}
                        </Text>
                        <Stack gap={4}>
                          {projs.map((p) => (
                            <ProjectRow
                              key={p.name}
                              name={p.name}
                              isGit={p.isGitRepo}
                              gitRemoteUrl={p.gitRemoteUrl}
                              projectPath={p.path}
                              status={
                                !p.hasEnv && p.hasEnvTemplate
                                  ? 'no-env'
                                  : p.missingEnvKeys.length > 0
                                    ? 'missing'
                                    : 'ready'
                              }
                              lastRun={lastRunStatus.data?.[`${p.tool}/${p.type}/${p.name}`]}
                              onEdit={() => startEditEnv(p.tool, p.type, p.name)}
                              onPull={
                                p.isGitRepo
                                  ? () =>
                                      pullOneMutation.mutate({
                                        tool: p.tool,
                                        type: p.type,
                                        project: p.name,
                                      })
                                  : undefined
                              }
                              isPulling={pullingProject === `${p.tool}/${p.type}/${p.name}`}
                              hasUpdate={updateLookup.get(`${p.tool}/${p.type}/${p.name}`) ?? false}
                              onRemove={() => setRemoveTarget(p)}
                            />
                          ))}
                        </Stack>
                      </Stack>
                    ))
                  )}
                </ToolSection>
              );
            })}
          </SimpleGrid>
        </>
      )}

      <CreateModal
        opened={createOpen}
        onClose={closeCreate}
        onSuccess={() => {
          closeCreate();
          queryClient.invalidateQueries({ queryKey: ['projects'] });
        }}
      />

      <CloneModal
        opened={cloneOpen}
        onClose={closeClone}
        initialTool={cloneTool}
        onSuccess={() => {
          closeClone();
          queryClient.invalidateQueries({ queryKey: ['projects'] });
        }}
      />

      <AddToolsModal
        opened={addToolsOpen}
        onClose={closeAddTools}
        onInstalled={() => {
          queryClient.invalidateQueries({ queryKey: ['tools'] });
          queryClient.invalidateQueries({ queryKey: ['projects'] });
        }}
      />

      <TypeToConfirmModal
        opened={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        title={t('projects.removeTitle')}
        description={t('projects.removeDesc')}
        expected={
          removeTarget ? `${removeTarget.tool}/${removeTarget.type}/${removeTarget.name}` : ''
        }
        confirmLabel={t('projects.removeConfirm')}
        loading={removeProjectMutation.isPending}
        onConfirm={() => removeTarget && removeProjectMutation.mutate(removeTarget)}
      />

      <EnvModal
        opened={!!editingEnv}
        title={
          !editingEnv
            ? ''
            : editingEnv.tool === 'scripts'
              ? 'scripts/.env'
              : `${editingEnv.project} [${editingEnv.tool}/${editingEnv.type}]`
        }
        envData={envQuery.data}
        isLoading={envQuery.isLoading}
        entries={editEntries}
        setEntries={setEditEntries}
        onPopulate={populateEntries}
        onSave={() => saveMutation.mutate()}
        onClose={() => setEditingEnv(null)}
        isSaving={saveMutation.isPending}
        editingEnv={editingEnv}
      />
    </Stack>
  );
}
