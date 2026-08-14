import type { RunRecord, RunRequest, RunStatus, ToolId } from '@hub/shared';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TbFolderPlus, TbPlus, TbRocket, TbX } from 'react-icons/tb';
import { api } from '~/api/client.js';
import { qProjects } from '~/api/queries.js';
import { BookmarkLoadMenu, BookmarkPanel } from '~/components/BookmarkPanel.js';
import { confirmDialog } from '~/components/confirmDialog.js';
import { EmptyState } from '~/components/EmptyState.js';
import { RunQueuePanel } from '~/components/RunQueuePanel.js';
import { useTools } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';
import { useNotifications } from '~/stores/hub.js';
import { useNavigationStore } from '~/stores/navigation.js';
import { getStatusColor } from '~/utils/run-status.js';
import { toolLabel } from '~/utils/tool-label.js';
import { RunSession, type SessionRef } from './RunSession.js';

function genId(): string {
  // crypto.randomUUID is available in all modern browsers and is collision-safe.
  return crypto.randomUUID();
}

interface SessionTab {
  id: string;
  status: RunStatus | 'idle';
  project: string;
  tool?: ToolId;
  initialConfig?: RunRequest;
  reconnectRunId?: string;
  reconnectCommand?: string;
}

export function RunPage() {
  const pendingConfig = useNavigationStore((s) => s.pendingRunConfig);
  const consumePendingRunConfig = useNavigationStore((s) => s.consumePendingRunConfig);
  const initialId = genId();
  const [sessions, setSessions] = useState<SessionTab[]>([
    { id: initialId, status: 'idle', project: '' },
  ]);
  const [activeId, setActiveId] = useState(initialId);
  const [reconnecting, setReconnecting] = useState(true);
  const sessionRefs = useRef<Map<string, SessionRef>>(new Map());
  const addNotification = useNotifications((s) => s.add);

  const navigate = useNavigate();
  const tools = useTools().data ?? [];
  const t = useT();

  // Detect first-time / no-projects state so we can guide the user instead of
  // showing an empty configuration form they cannot fill in.
  const projectsQ = useQuery({
    ...qProjects(),
    staleTime: 30_000,
  });
  const noProjects = !projectsQ.isLoading && (projectsQ.data?.length ?? 0) === 0;

  // Handle external config injection (from dashboard/spotlight). The effect
  // intentionally fires only when `pendingConfig` changes — the helpers it
  // calls are stable references that do not need to participate in the deps
  // array, so we silence the linter with an explicit reason.
  // biome-ignore lint/correctness/useExhaustiveDependencies: handleLoadBookmark and consumePendingRunConfig are stable references; we deliberately respond only to pendingConfig changes.
  useEffect(() => {
    if (!pendingConfig) return;
    handleLoadBookmark(pendingConfig);
    consumePendingRunConfig();
  }, [pendingConfig]);

  // Warn before refresh/close when any session is running
  useEffect(() => {
    const hasRunning = sessions.some((s) => s.status === 'running' || s.status === 'pending');
    if (!hasRunning) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [sessions]);

  // Reconnect to active runs after page load
  useEffect(() => {
    async function reconnect() {
      try {
        const activeRuns: RunRecord[] = await api.get('/api/runs/active');
        if (activeRuns.length === 0) return;

        const tabs: SessionTab[] = activeRuns.map((record) => ({
          id: genId(),
          status: 'running' as const,
          project: record.request.project,
          tool: record.request.tool,
          initialConfig: record.request,
          reconnectRunId: record.id,
          reconnectCommand: record.command,
        }));

        setSessions(tabs);
        setActiveId(tabs[0]?.id ?? '');
      } catch {
        // Server not ready, ignore
      } finally {
        setReconnecting(false);
      }
    }
    reconnect();
  }, []);

  function addSession(config?: RunRequest) {
    const id = genId();
    setSessions((prev) => [
      ...prev,
      {
        id,
        status: 'idle',
        project: config?.project ?? '',
        tool: config?.tool,
        initialConfig: config,
      },
    ]);
    setActiveId(id);
  }

  async function closeSession(id: string) {
    const session = sessions.find((s) => s.id === id);
    if (!session) return;
    const isRunning = session.status === 'running' || session.status === 'pending';
    const ok = await confirmDialog({
      title: isRunning ? t('run.closeRunningTitle') : t('run.closeSession'),
      message: isRunning ? t('run.closeRunningConfirm') : t('run.closeSessionConfirm'),
      confirmLabel: isRunning ? t('run.closeAndStop') : t('common.close'),
      danger: isRunning,
    });
    if (!ok) return;

    if (isRunning) {
      sessionRefs.current.get(id)?.cancel();
    }

    // Compute the next sessions list and the next active id outside the updater
    // so that React 19 concurrent re-runs of setSessions don't trigger duplicate
    // setActiveId calls or other side effects.
    const remaining = sessions.filter((s) => s.id !== id);
    if (remaining.length === 0) {
      const freshId = genId();
      setSessions([{ id: freshId, status: 'idle', project: '' }]);
      setActiveId(freshId);
    } else {
      setSessions(remaining);
      if (activeId === id) {
        setActiveId(remaining[0]?.id ?? '');
      }
    }
    sessionRefs.current.delete(id);
  }

  const handleStatusChange = useCallback(
    (sessionId: string, status: RunStatus | 'idle', project: string, tool?: ToolId) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, status, project, tool: tool ?? s.tool } : s)),
      );
      // Add to notification center on completion
      if (status === 'passed' || status === 'failed' || status === 'cancelled') {
        addNotification({
          type: status === 'passed' ? 'success' : status === 'failed' ? 'error' : 'warning',
          title:
            status === 'passed'
              ? t('run.testPassed')
              : status === 'failed'
                ? t('run.testFailed')
                : t('run.testCancelled'),
          message: tool ? `${project} · ${toolLabel(tool, tools)}` : project,
        });
      }
    },
    [addNotification, t, tools],
  );

  /** Live config of the active session's form — the bookmark filter scope, and
   * what the panel captures when saving. Read through the ref at call time, so
   * it is never a stale render snapshot. */
  const getActiveConfig = useCallback(
    (): RunRequest =>
      sessionRefs.current.get(activeId)?.getConfig() ?? {
        tool: 'playwright',
        type: '',
        project: '',
        mode: 'local',
      },
    [activeId],
  );

  function handleLoadBookmark(config: RunRequest) {
    const active = sessions.find((s) => s.id === activeId);
    if (active && active.status === 'idle') {
      const freshId = genId();
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeId
            ? {
                id: freshId,
                status: 'idle',
                project: config.project,
                tool: config.tool,
                initialConfig: config,
              }
            : s,
        ),
      );
      sessionRefs.current.delete(activeId);
      setActiveId(freshId);
    } else {
      addSession(config);
    }
  }

  // Keyboard shortcuts
  useHotkeys([
    [
      'mod+T',
      (e) => {
        e.preventDefault();
        addSession();
      },
    ],
    [
      'mod+W',
      (e) => {
        e.preventDefault();
        if (sessions.length > 1) closeSession(activeId);
      },
    ],
  ]);

  if (reconnecting) {
    return (
      <Center h="100%">
        <Group gap="sm">
          <Loader size="sm" />
          <Text c="dimmed" size="sm">
            {t('run.checkingActive')}
          </Text>
        </Group>
      </Center>
    );
  }

  // First-time experience: no projects exist yet. Guide the user to create one
  // instead of presenting a form with empty dropdowns and no clear next step.
  if (noProjects) {
    return (
      <EmptyState
        fullHeight
        icon={<TbRocket size={40} color="var(--mantine-color-brand-6)" />}
        title={t('run.firstTitle')}
        description={t('run.firstDesc')}
        action={
          <Group gap="xs">
            <Button
              leftSection={<TbFolderPlus size={14} />}
              onClick={() => navigate({ to: '/projects' })}
            >
              {t('run.goToProjects')}
            </Button>
            <Button
              variant="default"
              onClick={() => projectsQ.refetch()}
              loading={projectsQ.isFetching}
            >
              {t('run.justAdded')}
            </Button>
          </Group>
        }
      />
    );
  }

  return (
    // The page fills the content region and clips: every child below is pinned
    // except the sessions area, so nothing that mounts mid-run (inline alerts,
    // the command bar, the selected-tags block) can hand a scrollbar to the app
    // frame.
    <Stack gap="sm" style={{ height: '100%', minHeight: 0, overflow: 'hidden' }}>
      {/* Bookmarks — prominent position at top */}
      <div style={{ flexShrink: 0 }}>
        <BookmarkPanel
          getConfig={getActiveConfig}
          onLoad={handleLoadBookmark}
          disabled={sessions.find((s) => s.id === activeId)?.status === 'running'}
        />
      </div>

      {/* Queue & Active Runs — pinned in the fixed top region */}
      <div style={{ flexShrink: 0 }}>
        <RunQueuePanel />
      </div>

      {/* Tab bar + bookmark loader: one pinned row. The tabs scroll
          horizontally inside it; the loader is a dropdown pinned beside them, so
          neither adds height to the page. */}
      <Group gap="xs" wrap="nowrap" align="center" style={{ flexShrink: 0 }}>
        {/* The page headline. Every other page gets one from `PageHeader`, but this
            page is height-clipped and already stacks four pinned regions, so a
            full header row would cost ~50px of the run form for no new
            information. Riding in the tab row instead costs nothing and gives the
            page the `h1` it had no other way to get — without it the document
            outline started at h3 and assistive tech had no page heading to land
            on. `order={1}` takes its 24px size from the theme, so it stays in step
            with the other pages. */}
        <Title order={1} fz="h4" style={{ flexShrink: 0 }}>
          {t('nav.runTests')}
        </Title>
        <ScrollArea scrollbarSize={6} type="auto" style={{ flex: 1, minWidth: 0 }}>
          <Group gap={4} wrap="nowrap" pb={6}>
            {sessions.map((s) => {
              const isActive = activeId === s.id;
              const sColor = getStatusColor(s.status);
              return (
                <Group
                  key={s.id}
                  gap={0}
                  wrap="nowrap"
                  style={{
                    borderRadius: 8,
                    border: '1px solid var(--mantine-color-default-border)',
                    borderColor: isActive
                      ? 'var(--mantine-color-brand-filled)'
                      : 'var(--mantine-color-default-border)',
                    background: isActive
                      ? 'var(--mantine-color-brand-light)'
                      : 'var(--mantine-color-default)',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setActiveId(s.id)}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: '6px 10px',
                      cursor: 'pointer',
                      color: 'inherit',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 12,
                    }}
                  >
                    <Badge
                      size="xs"
                      color={sColor}
                      variant={s.status === 'running' ? 'dot' : 'filled'}
                      circle
                    />
                    <Text size="xs" fw={isActive ? 600 : 400}>
                      {s.project || t('run.newSession')}
                    </Text>
                    {s.tool && (
                      <Badge size="xs" color="gray" variant="light">
                        {toolLabel(s.tool, tools)}
                      </Badge>
                    )}
                  </button>
                  {sessions.length > 1 && (
                    <Tooltip label={t('run.closeSessionTip')} withArrow>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeSession(s.id);
                        }}
                        aria-label={t('run.closeSessionTip')}
                      >
                        <TbX size={14} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </Group>
              );
            })}
            <Tooltip label={t('run.newSessionTip')} withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="lg"
                onClick={() => addSession()}
                aria-label={t('run.newSessionTip')}
              >
                <TbPlus size={18} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </ScrollArea>
        <BookmarkLoadMenu getConfig={getActiveConfig} onLoad={handleLoadBookmark} />
      </Group>

      {/* Sessions — the only growing child, and the scroll owner for the
          stacked layout below `lg`, where the two session columns wrap onto two
          rows and cannot fit the clipped page height. */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain' }}>
        {sessions.map((s) => (
          <RunSession
            key={s.id}
            ref={(r: SessionRef | null) => {
              if (r) sessionRefs.current.set(s.id, r);
            }}
            sessionId={s.id}
            initialConfig={s.initialConfig}
            reconnectRunId={s.reconnectRunId}
            reconnectCommand={s.reconnectCommand}
            onStatusChange={handleStatusChange}
            visible={activeId === s.id}
          />
        ))}
      </div>
    </Stack>
  );
}
