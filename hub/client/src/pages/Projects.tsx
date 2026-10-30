import type { ProjectSummary, ToolId } from '@hub/shared';
import {
  Button,
  Group,
  Indicator,
  Loader,
  Paper,
  SimpleGrid,
  Skeleton,
  Stack,
  Tabs,
  Text,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { TbDownload, TbKey, TbList, TbPlus, TbPuzzle } from 'react-icons/tb';
import { api } from '~/api/client.js';
import { waitForHealth } from '~/api/health.js';
import { qEnv, qGitStatus, qProjects, qRunsLastStatus, queryRoots } from '~/api/queries.js';
import { EmptyState } from '~/components/EmptyState.js';
import { ErrorState } from '~/components/ErrorState.js';
import { PageHeader } from '~/components/PageHeader.js';
import { AddToolsModal } from '~/components/projects/AddToolsModal.js';
import { BundleModal } from '~/components/projects/BundleModal.js';
import { CloneModal } from '~/components/projects/CloneModal.js';
import { CreateModal } from '~/components/projects/CreateModal.js';
import {
  type EnvEntry,
  EnvModal,
  type EnvModalEditingTarget,
} from '~/components/projects/EnvModal.js';
import { ProjectRow } from '~/components/projects/ProjectRow.js';
import { StandaloneModal } from '~/components/projects/StandaloneModal.js';
import { ToolSection } from '~/components/projects/ToolSection.js';
import { ToolSectionActions } from '~/components/projects/ToolSectionActions.js';
import { toast } from '~/components/Toast.js';
import { TypeToConfirmModal } from '~/components/TypeToConfirmModal.js';
import { useTools } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';
import { EnvProfilesBody } from '~/pages/EnvProfiles.js';

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
  const [standaloneTarget, setStandaloneTarget] = useState<ProjectSummary | null>(null);
  const [bundleTarget, setBundleTarget] = useState<ProjectSummary | null>(null);
  const [activeTab, setActiveTab] = useState<'list' | 'env'>('list');

  const tools = useTools();

  // Seed the default-expanded set once, the first time the installed tools
  // resolve. Subsequent refetches won't override the user's collapse choices.
  const seededExpanded = useRef(false);
  useEffect(() => {
    if (seededExpanded.current || !tools.data) return;
    seededExpanded.current = true;
    setExpandedTools(new Set(['scripts', ...tools.data.map((t) => t.id)]));
  }, [tools.data]);
  const projects = useQuery(qProjects());
  const lastRunStatus = useQuery(qRunsLastStatus());

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
        [queryRoots.projects],
        [queryRoots.tools],
        [queryRoots.runsLastStatus],
        [queryRoots.runsHistory],
        [queryRoots.bookmarks],
        [queryRoots.schedules],
        [queryRoots.webhooks],
        [queryRoots.envProfiles],
        ['artifacts'],
        [queryRoots.gitStatus],
      ]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : t('projects.removeFailed')),
  });

  const gitStatus = useQuery({
    ...qGitStatus(),
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
        const error = status.error;
        toast.error(t('projects.pullAllError').replace('{error}', () => error));
        return;
      }

      const hubRebuild = status.results.find((r) => r.project === '(hub-rebuild)');
      const pullResults = status.results.filter((r) => r.project !== '(hub-rebuild)');
      const failed = pullResults.filter((r) => !r.success);

      if (failed.length === 0) {
        toast.success(t('projects.pullAllSuccess').replace('{n}', String(pullResults.length)));
      } else {
        const list = failed.map((f) => f.project).join(', ');
        toast.error(
          t('projects.pullSomeFailed')
            .replace('{failed}', String(failed.length))
            .replace('{total}', String(pullResults.length))
            .replace('{list}', () => list),
        );
      }

      if (hubRebuild && !hubRebuild.success) {
        const output = hubRebuild.output;
        toast.error(t('projects.hubRebuildFailed').replace('{output}', () => output));
      } else if (hubRebuild?.success) {
        toast.success(t('projects.hubRebuilt'));
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: [queryRoots.projects] });
      queryClient.invalidateQueries({ queryKey: [queryRoots.gitStatus] });
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
      if (data.success) {
        toast.success(t('projects.pullOneSuccess').replace('{project}', () => data.project));
      } else {
        toast.error(
          t('projects.pullOneFailed')
            .replace('{project}', () => data.project)
            .replace('{output}', () => data.output),
        );
      }
      queryClient.invalidateQueries({ queryKey: [queryRoots.gitStatus] });
    },
    onError: () => {
      setPullingProject(null);
      toast.error(t('projects.pullFailed'));
    },
  });

  const envQuery = useQuery(qEnv(editingEnv, !!editingEnv));

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
      queryClient.invalidateQueries({ queryKey: [queryRoots.projects] });
      queryClient.invalidateQueries({ queryKey: [queryRoots.env] });
      // Editing scripts/.env (SPREADSHEET_ID / FORCE_TRACK) changes usage-logging
      // readiness — refresh its badge/toggle too.
      queryClient.invalidateQueries({ queryKey: [queryRoots.usageLogging] });
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
        title={t('nav.projects')}
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
                variant="default"
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

      <Tabs value={activeTab} onChange={(v) => setActiveTab((v as 'list' | 'env') ?? 'list')}>
        <Tabs.List mb="md">
          <Tabs.Tab value="list" leftSection={<TbList size={16} />}>
            {t('projects.tabList')}
          </Tabs.Tab>
          <Tabs.Tab value="env" leftSection={<TbKey size={16} />}>
            {t('nav.envProfiles')}
          </Tabs.Tab>
        </Tabs.List>
      </Tabs>

      {activeTab === 'env' && <EnvProfilesBody />}

      {activeTab === 'list' && projects.isLoading && (
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

      {activeTab === 'list' && projects.isError && (
        <ErrorState onRetry={() => projects.refetch()} />
      )}

      {activeTab === 'list' && !projects.isLoading && !projects.isError && (
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
          </ToolSection>

          {/* Tool sections flow into two columns on desktop (left/right),
              single column on smaller screens. `alignItems: start` stops short
              sections from stretching to match a taller neighbour. */}
          <SimpleGrid
            cols={{ base: 1 }}
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
                              onMakeStandalone={
                                tool.supportsStandalone ? () => setStandaloneTarget(p) : undefined
                              }
                              onExportBundle={
                                tool.supportsBundle ? () => setBundleTarget(p) : undefined
                              }
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

          {(tools.data ?? []).length === 0 && (
            <EmptyState
              icon={<TbPuzzle size={40} color="var(--mantine-color-brand-6)" />}
              title={t('projects.noToolsTitle')}
              description={t('projects.noToolsDesc')}
              action={
                <Button leftSection={<TbPuzzle size={14} />} onClick={openAddTools}>
                  {t('projects.addTools')}
                </Button>
              }
            />
          )}
        </>
      )}

      <CreateModal
        opened={createOpen}
        onClose={closeCreate}
        onSuccess={() => {
          closeCreate();
          queryClient.invalidateQueries({ queryKey: [queryRoots.projects] });
        }}
      />

      <CloneModal
        opened={cloneOpen}
        onClose={closeClone}
        initialTool={cloneTool}
        onSuccess={() => {
          closeClone();
          queryClient.invalidateQueries({ queryKey: [queryRoots.projects] });
        }}
      />

      <AddToolsModal
        opened={addToolsOpen}
        onClose={closeAddTools}
        onInstalled={() => {
          queryClient.invalidateQueries({ queryKey: [queryRoots.tools] });
          queryClient.invalidateQueries({ queryKey: [queryRoots.projects] });
        }}
      />

      <StandaloneModal
        target={standaloneTarget}
        onClose={() => setStandaloneTarget(null)}
        onSuccess={() => setStandaloneTarget(null)}
      />
      <BundleModal target={bundleTarget} onClose={() => setBundleTarget(null)} />

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
