/**
 * RunSession orchestrates the run/config state for one session. The imperative
 * terminal (xterm) and WebSocket plumbing now live in `useRunTerminal` and
 * `useRunSocket`. The effects that remain here intentionally omit the stable
 * `prefs` store from their deps (persisting / prefilling last-used tool, type,
 * and project) — including it would re-run them on unrelated preference changes.
 * The file-level ignore documents that these omissions are deliberate.
 */
// biome-ignore-all lint/correctness/useExhaustiveDependencies: remaining effects intentionally omit the stable prefs store; see note above.
import type {
  DoctorReport,
  HeadlessMode,
  PerformanceType,
  RunMode,
  RunRecord,
  RunRequest,
  RunStatus,
  RunSummary,
  ToolId,
} from '@hub/shared';
import { missingChecksForTool } from '@hub/shared';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Checkbox,
  Code,
  Group,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  TbAlertTriangle,
  TbBookmarkPlus,
  TbChevronDown,
  TbChevronUp,
  TbCopy,
  TbDeviceMobile,
  TbPlayerPlay,
  TbPlayerStop,
  TbRefresh,
  TbSearch,
  TbTextDecrease,
  TbTextIncrease,
  TbX,
} from 'react-icons/tb';
import { api } from '~/api/client.js';
import { qProjectEnv } from '~/api/queries.js';
import { useSaveBookmark } from '~/components/BookmarkPanel.js';
import { confirmDialog } from '~/components/confirmDialog.js';
import { FormModal } from '~/components/FormModal.js';
import { InlineAlert } from '~/components/InlineAlert.js';
import { SectionSelect } from '~/components/SectionSelect.js';
import { TagSelector } from '~/components/TagSelector.js';
import { toast } from '~/components/Toast.js';
import {
  useProjectList,
  useProjectSections,
  useProjectTags,
  useProjectTypes,
} from '~/hooks/useProjectQueries.js';
import { useRunSocket } from '~/hooks/useRunSocket.js';
import { useRunTerminal } from '~/hooks/useRunTerminal.js';
import { useTools } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';
import { usePreferences } from '~/stores/hub.js';
import { buildPerfTypeData } from '~/utils/perf-type-options.js';
import { mergeExtraArgs, parseRunArgs, SUPPORTS_RUN_FLAGS } from '~/utils/run-flags.js';
import { getStatusColor } from '~/utils/run-status.js';
import { runVerdict } from '~/utils/run-verdict.js';
import { buildTagQuery, parseTagQuery } from '~/utils/tag-selection.js';
import { toolLabel, toolSelectData } from '~/utils/tool-label.js';

/** Split bounds mirror the clamp the preferences store commits, so the live drag
 *  preview can never show a width that will not be saved. */
const SPLIT_MIN = 25;
const SPLIT_MAX = 70;
/** One arrow-key press on the divider moves the split by this many percent. */
const SPLIT_STEP = 2;
/** Terminal font bounds mirror the store's clamp, so A−/A+ can be disabled at
 *  the ends instead of clicking to no effect. */
const FONT_MIN = 9;
const FONT_MAX = 20;

export interface SessionRef {
  cancel: () => void;
  getStatus: () => RunStatus | 'idle';
  getProject: () => string;
  getConfig: () => RunRequest;
}

interface RunSessionProps {
  sessionId: string;
  initialConfig?: RunRequest;
  reconnectRunId?: string;
  reconnectCommand?: string;
  onStatusChange: (
    sessionId: string,
    status: RunStatus | 'idle',
    project: string,
    tool?: ToolId,
  ) => void;
  visible: boolean;
}

export const RunSession = forwardRef<SessionRef, RunSessionProps>(function RunSession(
  { sessionId, initialConfig, reconnectRunId, reconnectCommand, onStatusChange, visible },
  ref,
) {
  const t = useT();
  const prefs = usePreferences();
  const queryClient = useQueryClient();
  const saveBookmark = useSaveBookmark();

  const [tool, setTool] = useState<ToolId>(initialConfig?.tool ?? prefs.lastTool);
  const [mode, setMode] = useState<RunMode>(initialConfig?.mode ?? prefs.defaultMode);
  const [type, setType] = useState(initialConfig?.type ?? '');
  const [project, setProject] = useState(initialConfig?.project ?? '');
  const initialSelection = parseTagQuery(initialConfig?.tool ?? '', initialConfig?.tag);
  const [selectedTags, setSelectedTags] = useState<string[]>(initialSelection.include);
  const [excludedTags, setExcludedTags] = useState<string[]>(initialSelection.exclude);
  const [headless, setHeadless] = useState<HeadlessMode>(
    initialConfig?.headless ?? prefs.defaultHeadless,
  );
  // Saved configs store the composed argument string, so split it back apart to
  // hydrate the typed fields (round-trip pair — brain LESS-073).
  const initialArgs = parseRunArgs(initialConfig?.extraArgs);
  const [extraArgs, setExtraArgs] = useState(initialArgs.rest);
  const [workers, setWorkers] = useState<number | null>(initialArgs.workers ?? null);
  const [repeatEach, setRepeatEach] = useState<number | null>(initialArgs.repeatEach ?? null);

  const [noTrack, setNoTrack] = useState(initialConfig?.noTrack ?? false);
  const [silent, setSilent] = useState(initialConfig?.silent ?? false);
  const [discardReport, setDiscardReport] = useState(initialConfig?.discardReport ?? false);
  const [section, setSection] = useState(initialConfig?.section ?? '');
  const [perfType, setPerfType] = useState<PerformanceType>(
    initialConfig?.performanceType ?? 'LOAD',
  );

  const [runStatus, setRunStatus] = useState<RunStatus | 'idle'>('idle');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [lastCommand, setLastCommand] = useState('');
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState('');
  const [runSummary, setRunSummary] = useState<RunSummary | null>(null);
  const fullOutputRef = useRef('');
  const activeRunIdRef = useRef<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [bookmarkName, setBookmarkName] = useState('');
  // Width while a drag is in flight; `null` means "use the saved percent". The
  // store is written once, on release, so the terminal re-fits once per drag.
  const [dragPercent, setDragPercent] = useState<number | null>(null);
  const [dividerFocused, setDividerFocused] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  const isRunning = runStatus === 'running' || runStatus === 'pending';
  const isFinished = runStatus !== 'idle' && !isRunning;
  const advancedMode = prefs.advancedMode;
  // Raw CLI flags reach the runner unvalidated, so they are an advanced-only
  // field AND an advanced-only value: in simple view the field is hidden and its
  // (still-kept) text is not sent, so a value typed earlier cannot leak into the
  // next run.
  const supportsRunFlags = SUPPORTS_RUN_FLAGS.has(tool);
  /**
   * Basic mode runs locally, full stop: the Docker choice needs a running daemon
   * and an understanding of the compose setup, so it belongs to advanced mode.
   * Derived rather than written back to state, so flipping advanced mode back on
   * restores whatever the user had picked.
   */
  const effectiveMode: RunMode = advancedMode ? mode : 'local';

  // Free text is advanced-mode only; the typed flags always apply. Merging here
  // means a flag set in both places resolves once, in favour of the typed field.
  const effectiveExtraArgs = mergeExtraArgs(
    advancedMode ? extraArgs || undefined : undefined,
    supportsRunFlags ? { workers, repeatEach } : {},
  );

  // The bar under the terminal carries the command (advanced only), Rerun and
  // the duration. In simple view during a run it would hold none of those, so
  // it is dropped entirely and the terminal takes the whole column height.
  const showRunBar = !!lastCommand && (advancedMode || !isRunning);

  // Layout the user arranged, remembered rather than asked for again.
  const formCollapsed = prefs.runFormCollapsed;
  /** Collapse/expand control — placed inline by the caller, never on its own row. */
  const collapseToggle = (
    <Tooltip label={formCollapsed ? t('run.editConfig') : t('run.hideConfig')} withArrow>
      <ActionIcon
        size="sm"
        variant="subtle"
        color="gray"
        onClick={() => prefs.setRunFormCollapsed(!formCollapsed)}
        aria-label={formCollapsed ? t('run.editConfig') : t('run.hideConfig')}
        aria-expanded={!formCollapsed}
        style={{ flex: 'none' }}
      >
        {formCollapsed ? <TbChevronDown size={16} /> : <TbChevronUp size={16} />}
      </ActionIcon>
    </Tooltip>
  );
  const splitPercent = prefs.runSplitPercent;
  const fontSize = prefs.terminalFontSize;
  // The saved percent except mid-drag, when the preview follows the pointer.
  const columnPercent = dragPercent ?? splitPercent;

  // The footer's save action captures the form as it stands: nothing to capture
  // without a project, and nothing new to capture mid-run (the form is locked
  // while a run is in flight).
  const saveBookmarkReason = !project
    ? t('run.selectProjectFirst')
    : isRunning
      ? t('run.testRunning')
      : null;

  // Terminal (xterm) and the per-session WebSocket live in dedicated hooks so
  // this component orchestrates state while the imperative plumbing stays in
  // one place. `term` is a stable API; `send` posts subscribe/cancel messages.
  // `refitKey` covers every change to the terminal container's box, not just the
  // run status: the bottom bar and the search row mount/unmount without one
  // (e.g. toggling advanced mode mid-run), and the committed split percent
  // changes the column's width — either would leave the canvas stale.
  const { termRef, term } = useRunTerminal({
    visible,
    refitKey: `${runStatus}|${showRunBar}|${searchOpen}|${splitPercent}`,
    fontSize,
  });
  const { send } = useRunSocket({
    term,
    activeRunIdRef,
    fullOutputRef,
    setRunStatus,
    setRunSummary,
    setActiveRunId,
    setLastCommand,
    reconnectRunId,
    reconnectCommand,
    t,
  });

  useImperativeHandle(ref, () => ({
    cancel: () => handleCancel(),
    getStatus: () => runStatus,
    getProject: () => project,
    getConfig: () => currentConfig(),
  }));

  useEffect(() => {
    activeRunIdRef.current = activeRunId;
  }, [activeRunId]);

  // Keep the latest onStatusChange without making it an effect dependency. The
  // parent recreates this callback every render (it closes over the i18n `t`,
  // which is a fresh function per render). Depending on its identity here would
  // re-fire the effect on every render → setState → re-render → React error
  // #185 (maximum update depth). We report only when the real status/identity
  // values change.
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    onStatusChangeRef.current(sessionId, runStatus, project, tool);
  }, [sessionId, runStatus, project, tool]);

  // Persist last-used type and project (for bookmark/reconnect convenience only)
  useEffect(() => {
    if (tool && type) prefs.setLastType(tool, type);
  }, [tool, type]);

  useEffect(() => {
    if (tool && type && project) prefs.setLastProject(tool, type, project);
  }, [tool, type, project]);

  const config = useQuery<{ forceTrack: boolean; dockerRunning: boolean }>({
    queryKey: ['config'],
    queryFn: () => api.get('/api/config'),
    gcTime: Infinity,
    // Config (forceTrack/dockerRunning) is stable within a session; without a
    // staleTime it refetched on every session mount / window refocus.
    staleTime: Infinity,
  });

  // Full doctor report (shares the ['doctor'] cache with the Dashboard panel).
  // Drives both the credentials notice and the per-tool run-requirement gate.
  const doctorQ = useQuery<DoctorReport>({
    queryKey: ['doctor'],
    queryFn: () => api.get('/api/doctor'),
    staleTime: 10_000,
  });

  // Force mode to local if Docker is not running
  useEffect(() => {
    if (config.data && !config.data.dockerRunning && mode === 'docker') {
      setMode('local');
    }
  }, [config.data, mode]);

  // Derive the selected tool's project axes from its manifest (via useTools),
  // replacing hardcoded `tool === 'k6'` branches so any portable tool works.
  const toolsQuery = useTools();
  const toolView = (toolsQuery.data ?? []).find((t) => t.id === tool);
  const sectionAxis = toolView?.projects.sectionAxis ?? false;
  /** Fields actually rendered in the options row — drives its column count. */
  const optionFieldCount =
    (advancedMode ? 1 : 0) + (sectionAxis ? 0 : 1) + (!sectionAxis && supportsRunFlags ? 2 : 0);
  const typeAxis = toolView?.projects.typeAxis ?? true;
  const fixedType = toolView?.projects.fixedType ?? null;

  // Run-requirement gate: doctor checks this tool needs but that are missing
  // (e.g. Robot → uv, python). Blocks Run up-front and lists exactly what to
  // install, so the user never launches a doomed run.
  const missingReqs =
    toolView && doctorQ.data ? missingChecksForTool(toolView, doctorQ.data.checks) : [];

  const effectiveType = typeAxis ? type : (fixedType ?? '');
  const types = useProjectTypes(tool);
  const projectsQ = useProjectList(tool, effectiveType);
  const sectionsQ = useProjectSections(project, sectionAxis);
  // Project .env drives the live VU counts shown in the perf-type labels
  // (PEAK_VUS → LOAD, MINIMAL_LOAD_VUS → MINIMAL_LOAD); only fetched for a
  // section-axis tool (k6), where the perf-type Select is shown.
  const projectEnvQ = useQuery(
    qProjectEnv(sectionAxis ? tool : '', effectiveType, sectionAxis ? project : ''),
  );
  const perfTypeData = buildPerfTypeData(projectEnvQ.data?.entries);
  const tags = useProjectTags(sectionAxis ? '' : tool, effectiveType, project);

  // One line of what a run will use, read from the same live state
  // `currentConfig()` submits: the axes that decide a run's identity, in the
  // order their fields appear in the expanded form.
  const configSummary = [
    toolLabel(tool, toolsQuery.data ?? []),
    sectionAxis ? section : effectiveType,
    project || t('run.selectProjectFirst'),
    sectionAxis ? '' : headless === 'headed' ? t('run.headed') : t('run.headless'),
  ]
    .filter(Boolean)
    .join(' · ');

  // Mobile (Robot type=mobile) needs the host Appium server running. Gate the
  // Run button on it and offer a one-click start (Option A: host appium).
  const isMobile = effectiveType === 'mobile';
  const appiumQ = useQuery<{ running: boolean; installed: boolean }>({
    queryKey: ['appium-status'],
    queryFn: () => api.get('/api/appium/status'),
    enabled: isMobile,
    refetchInterval: isMobile ? 5000 : false,
  });
  const appiumRunning = appiumQ.data?.running ?? false;
  const startAppium = useMutation({
    mutationFn: () => api.post('/api/appium/start'),
    onSuccess: () => {
      toast.success(t('run.appiumStarting'));
      queryClient.invalidateQueries({ queryKey: ['appium-status'] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const credentialsMissing = !!doctorQ.data && !doctorQ.data.credentialsOk && !noTrack;
  const appiumMissing = isMobile && !appiumRunning;
  const hasGatingAlerts = credentialsMissing || missingReqs.length > 0 || appiumMissing;

  // Gating information, not configuration: each line states why Run is disabled
  // and what to do about it, so it stays in the card while the form is collapsed.
  // Pinned (`flexShrink: 0`) so a short column squeezes the field area — which
  // has its own scroll — and never the alerts.
  const gatingAlerts = hasGatingAlerts ? (
    <Stack gap="xs" style={{ flexShrink: 0 }}>
      {credentialsMissing && (
        <InlineAlert
          icon={<TbAlertTriangle size={14} />}
          message={t('run.credentialsMissing')}
          action={
            <Button
              size="compact-xs"
              variant="light"
              color="yellow"
              onClick={() => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json';
                input.onchange = async () => {
                  const file = input.files?.[0];
                  if (!file) return;
                  const content = await file.text();
                  try {
                    await api.post('/api/doctor/upload-credentials', {
                      content,
                      filename: file.name,
                    });
                    toast.success(t('run.credentialsUploaded'));
                    doctorQ.refetch();
                  } catch {
                    toast.error(t('run.credentialsUploadFailed'));
                  }
                };
                input.click();
              }}
            >
              {t('run.uploadCredentials')}
            </Button>
          }
        />
      )}
      {missingReqs.length > 0 && (
        <InlineAlert
          icon={<TbAlertTriangle size={14} />}
          message={`${t('run.missingRequirements')}: ${missingReqs.join(', ')}. ${t('run.missingRequirementsHint')}`}
        />
      )}
      {appiumMissing && (
        <InlineAlert
          icon={<TbDeviceMobile size={14} />}
          message={t('run.appiumWarning')}
          action={
            <Button
              size="compact-xs"
              variant="light"
              color="yellow"
              onClick={() => startAppium.mutate()}
              loading={startAppium.isPending}
              disabled={appiumQ.data ? !appiumQ.data.installed : false}
            >
              {t('run.startAppium')}
            </Button>
          }
        />
      )}
    </Stack>
  ) : null;

  useEffect(() => {
    if (typeAxis && types.data && types.data.length > 0 && !type) {
      // Prefer the last-used type for this tool so returning users don't re-pick
      // it every session; fall back to the first available type.
      const preferred = prefs.lastType[tool];
      setType(preferred && types.data.includes(preferred) ? preferred : (types.data[0] ?? ''));
    }
  }, [typeAxis, types.data, type, tool]);

  // Auto-select the last-used project once the project list loads. Applies to
  // every session (fresh, bookmark, or reconnect) so a returning user lands on
  // a ready-to-run form; they can still change it. Only fills when the saved
  // project actually exists in the current list.
  useEffect(() => {
    if (projectsQ.data && projectsQ.data.length > 0 && !project) {
      const lastProj = prefs.lastProject[`${tool}/${effectiveType}`];
      if (lastProj && projectsQ.data.includes(lastProj)) {
        setProject(lastProj);
      }
    }
  }, [projectsQ.data, project, tool, effectiveType]);

  // Timer
  useEffect(() => {
    if (!isRunning || !startTime) return;
    const interval = setInterval(() => {
      const diff = Math.floor((Date.now() - startTime) / 1000);
      const m = Math.floor(diff / 60);
      const s = diff % 60;
      setElapsed(m > 0 ? `${m}m ${s}s` : `${s}s`);
    }, 1000);
    return () => clearInterval(interval);
  }, [isRunning, startTime]);

  const runMutation = useMutation<RunRecord, Error, RunRequest>({
    mutationFn: (req) => api.post('/api/runs', req),
    onSuccess: (record) => {
      setRunStatus('running');
      setActiveRunId(record.id);
      setLastCommand(record.command);
      setStartTime(Date.now());
      setElapsed('0s');
      setRunSummary(null);
      fullOutputRef.current = '';
      term.clear();
      term.writeln(`\x1b[32m[Started]\x1b[0m Run ${record.id}`);
      term.writeln(`\x1b[90m$ ${record.command}\x1b[0m\n`);
      send({ kind: 'subscribe', runId: record.id, replay: true });
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      queryClient.invalidateQueries({ queryKey: ['activeRuns'] });
    },
  });

  /** The form as it stands right now: what the parent's ref reads and what a
   *  bookmark captures, so both can never drift from each other. */
  function currentConfig(): RunRequest {
    return {
      tool,
      type: effectiveType,
      project,
      mode: effectiveMode,
      tag: buildTagQuery(tool, selectedTags, excludedTags),
      headless: !sectionAxis ? headless : undefined,
      extraArgs: effectiveExtraArgs,
      noTrack,
      silent,
      // Silent discards the report already, so never send both — the stored
      // config then reads as exactly one intent.
      discardReport: discardReport && !silent,
      section: sectionAxis ? section : undefined,
      performanceType: sectionAxis ? perfType : undefined,
    };
  }

  /** Prefill for the save-bookmark modal, built from the run's own axes
   *  (project, section-or-type, tag count) so accepting it is one keypress. */
  function defaultBookmarkName(): string {
    const axes = [project, sectionAxis ? section : effectiveType].filter(Boolean).join(' · ');
    return selectedTags.length > 0 ? `${axes} · ${selectedTags.length} ${t('run.tags')}` : axes;
  }

  function handleSaveBookmark() {
    saveBookmark.reset();
    setBookmarkName(defaultBookmarkName());
    setSaveModalOpen(true);
  }

  /** The footer's save is the only create path for bookmarks, so the name is
   *  the user's to confirm; the config is whatever the form holds right now. */
  function submitSaveBookmark() {
    const name = bookmarkName.trim();
    if (!name) return;
    saveBookmark.mutate(
      { name, config: currentConfig() },
      {
        onSuccess: () => {
          setSaveModalOpen(false);
          setBookmarkName('');
        },
      },
    );
  }

  function handleRun() {
    const tagExpr = buildTagQuery(tool, selectedTags, excludedTags);
    const effectiveNoTrack = config.data?.forceTrack ? false : noTrack;
    runMutation.mutate({
      tool,
      type: effectiveType,
      project,
      mode: effectiveMode,
      tag: tagExpr,
      headless: !sectionAxis ? headless : undefined,
      extraArgs: effectiveExtraArgs,
      noTrack: effectiveNoTrack,
      silent,
      discardReport: discardReport && !silent,
      section: sectionAxis ? section : undefined,
      performanceType: sectionAxis ? perfType : undefined,
    });
  }

  async function handleCancel() {
    if (!activeRunId) return;
    const ok = await confirmDialog({
      title: t('run.cancelTestTitle'),
      message: t('run.cancelTestConfirm'),
      confirmLabel: t('run.cancelTestConfirmLabel'),
      cancelLabel: t('run.keepRunning'),
      danger: true,
    });
    if (!ok) return;
    send({ kind: 'cancel', runId: activeRunId });
  }

  function handleRerun() {
    if (runMutation.data) runMutation.mutate(runMutation.data.request);
  }

  async function handleCopyCommand() {
    if (!lastCommand) return;
    try {
      await navigator.clipboard.writeText(lastCommand);
      toast.success(t('runlog.commandCopied'));
    } catch {
      toast.error(t('common.copyFailed'));
    }
  }

  function clampSplit(percent: number): number {
    return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Math.round(percent)));
  }

  /** Pointer capture keeps the move/up events on the handle once the drag starts,
   *  so the pointer may leave the 6px strip without dropping the drag. */
  function handleDividerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragPercent(splitPercent);
  }

  function handleDividerMove(e: React.PointerEvent<HTMLDivElement>) {
    const row = rowRef.current;
    if (dragPercent === null || !row) return;
    const rect = row.getBoundingClientRect();
    if (rect.width === 0) return;
    // Rounding to whole percent means an unchanged value bails out of the
    // render, so a slow drag does not re-render per pixel.
    setDragPercent(clampSplit(((e.clientX - rect.left) / rect.width) * 100));
  }

  function handleDividerUp() {
    if (dragPercent === null) return;
    prefs.setRunSplitPercent(dragPercent);
    setDragPercent(null);
  }

  function handleDividerKeys(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.key === 'ArrowLeft' ? -SPLIT_STEP : e.key === 'ArrowRight' ? SPLIT_STEP : 0;
    if (step === 0) return;
    e.preventDefault();
    prefs.setRunSplitPercent(clampSplit(splitPercent + step));
  }

  // Ctrl/Cmd + Enter to run when this session is visible
  useHotkeys([
    [
      'mod+Enter',
      () => {
        if (visible && project && !isRunning) handleRun();
      },
    ],
    [
      'mod+f',
      () => {
        if (visible) {
          setSearchOpen((v) => !v);
        }
      },
    ],
  ]);

  return (
    <div
      ref={rowRef}
      style={{
        display: visible ? 'flex' : 'none',
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 'var(--mantine-spacing-sm)',
        height: '100%',
        minHeight: 0,
      }}
    >
      {/* Left column: fills the row height so its bottom sits flush with the
          Run button. Every field is fixed EXCEPT the tag-group list, which
          fills the middle and scrolls on its own (TagSelector `fill`) — the
          form itself never scrolls. The Run/Stop footer is pinned below, level
          with the command bar on the right. */}
      {/* Side by side from `md` (992px) up, not `lg`: below the split point the
          column takes the full width and the terminal wraps to a second row, and
          two rows of `height:100%` make the session twice the viewport — the
          scrollbar users kept hitting at 1024-1199px. When it does wrap (真
          narrow), the rows size to content instead of demanding 100% each. */}
      <Stack
        gap="xs"
        w={{ base: '100%', md: `${columnPercent}%` }}
        h={{ base: 'auto', md: '100%' }}
        style={{ flexShrink: 0, minHeight: 0 }}
      >
        <Paper
          p="xs"
          withBorder
          style={{
            opacity: isRunning ? 0.85 : 1,
            // Expanded, the card is the growing member of the column. Collapsed,
            // it is one line plus the gating alerts, so it takes its natural
            // height (`0 1 auto`) and shrinks — scrolling inside itself — only on
            // a viewport too short for it, rather than growing into empty space.
            flex: formCollapsed ? '0 1 auto' : 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--mantine-spacing-xs)',
            overflow: formCollapsed ? 'auto' : 'hidden',
            // A wheel that reaches the end of the collapsed card must not chain
            // to the sessions wrapper and jump the page.
            overscrollBehavior: 'contain',
          }}
        >
          {/* Collapsed, this row is the whole card: the summary plus the toggle.
              Expanded, the toggle rides along the target row instead of owning a
              full-width row of its own that shows one 16px icon. */}
          {formCollapsed && (
            <Group gap="xs" wrap="nowrap" justify="space-between" style={{ flexShrink: 0 }}>
              <Text size="xs" fw={500} truncate style={{ flex: 1, minWidth: 0 }}>
                {configSummary}
              </Text>
              {collapseToggle}
            </Group>
          )}
          {!formCollapsed && (
            <Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
              {/* Row 1 — WHAT to run. The three axes that decide the target sit on
                  one line so the eye reads them together; the collapse toggle
                  rides at the end instead of costing its own row. */}
              <Group gap="xs" align="flex-end" wrap="nowrap">
                <SimpleGrid
                  cols={{ base: 1, xs: typeAxis ? 3 : 2 }}
                  spacing="xs"
                  style={{ flex: 1, minWidth: 0 }}
                >
                  <Select
                    label={t('run.tool')}
                    size="xs"
                    disabled={isRunning}
                    value={tool}
                    onChange={(v) => {
                      if (!v) return;
                      setTool(v as ToolId);
                      setType('');
                      setProject('');
                      setSelectedTags([]);
                    }}
                    data={toolSelectData(toolsQuery.data ?? [])}
                    allowDeselect={false}
                  />
                  {typeAxis && (
                    <Select
                      label={t('run.type')}
                      size="xs"
                      disabled={isRunning}
                      value={type || null}
                      onChange={(v) => {
                        setType(v ?? '');
                        setProject('');
                        setSelectedTags([]);
                      }}
                      placeholder={t('common.select')}
                      data={types.data ?? []}
                      searchable
                    />
                  )}
                  <Select
                    label={t('run.project')}
                    size="xs"
                    disabled={isRunning}
                    value={project || null}
                    onChange={(v) => {
                      setProject(v ?? '');
                      setSelectedTags([]);
                    }}
                    placeholder={projectsQ.isLoading ? t('common.loading') : t('common.select')}
                    data={projectsQ.data ?? []}
                    searchable
                  />
                </SimpleGrid>
                {collapseToggle}
              </Group>

              {/* Row 2 — HOW to run. Mode, display and the tuning numbers share one
                  line; each was a near-empty block of its own before. */}
              <SimpleGrid cols={{ base: 2, xs: Math.max(2, optionFieldCount) }} spacing="xs">
                {/* Docker needs a running daemon and knowledge of the compose
                    setup, so basic mode neither shows it nor uses it —
                    `effectiveMode` pins the run to local. A visible-but-ignored
                    select would be the worse half-measure. */}
                {advancedMode && (
                  <Select
                    label={t('run.mode')}
                    size="xs"
                    disabled={isRunning}
                    value={mode}
                    onChange={(v) => v && setMode(v as RunMode)}
                    data={[
                      { value: 'local', label: t('run.modeLocal') },
                      {
                        value: 'docker',
                        label: `Docker${!config.data?.dockerRunning ? ` (${t('run.notRunning')})` : ''}`,
                        disabled: !config.data?.dockerRunning,
                      },
                    ]}
                    allowDeselect={false}
                  />
                )}
                {!sectionAxis && (
                  <Select
                    label={t('run.display')}
                    size="xs"
                    disabled={isRunning}
                    value={headless}
                    onChange={(v) => v && setHeadless(v as HeadlessMode)}
                    data={[
                      { value: 'headless', label: t('run.headless') },
                      { value: 'headed', label: t('run.headed') },
                    ]}
                    allowDeselect={false}
                  />
                )}
                {!sectionAxis && supportsRunFlags && (
                  <>
                    <NumberInput
                      label={t('run.workers')}
                      size="xs"
                      min={1}
                      max={64}
                      disabled={isRunning}
                      value={workers ?? ''}
                      onChange={(v: string | number) =>
                        setWorkers(typeof v === 'number' ? v : null)
                      }
                      placeholder={t('run.autoDefault')}
                    />
                    <NumberInput
                      label={t('run.repeatEach')}
                      size="xs"
                      min={1}
                      max={50}
                      disabled={isRunning}
                      value={repeatEach ?? ''}
                      onChange={(v: string | number) =>
                        setRepeatEach(typeof v === 'number' ? v : null)
                      }
                      placeholder="1"
                    />
                  </>
                )}
              </SimpleGrid>

              {sectionAxis && project && (
                <SimpleGrid cols={2} spacing="xs">
                  <SectionSelect
                    label={t('run.section')}
                    disabled={isRunning}
                    value={section}
                    onChange={setSection}
                    placeholder={t('common.select')}
                    sections={sectionsQ.data ?? []}
                  />
                  <Select
                    label={t('run.perfType')}
                    size="xs"
                    disabled={isRunning}
                    value={perfType}
                    onChange={(v) => v && setPerfType(v as PerformanceType)}
                    data={perfTypeData}
                    allowDeselect={false}
                  />
                </SimpleGrid>
              )}

              {!sectionAxis && project && !isRunning && (
                <TagSelector
                  tags={tags.data}
                  isLoading={tags.isLoading}
                  selectedTags={selectedTags}
                  onChange={setSelectedTags}
                  excludedTags={excludedTags}
                  onExcludeChange={setExcludedTags}
                  matchPanelAt="bottom"
                  fill
                />
              )}
              {!sectionAxis && project && isRunning && selectedTags.length > 0 && (
                <Stack gap={4}>
                  <Text size="xs" c="dimmed">
                    {t('run.tags')}
                  </Text>
                  <Group gap={4}>
                    {selectedTags.map((tag) => (
                      <Badge key={tag} size="sm" color="blue" variant="filled">
                        {tag}
                      </Badge>
                    ))}
                  </Group>
                </Stack>
              )}

              {advancedMode && !sectionAxis && (
                <TextInput
                  label={t('run.extraArgs')}
                  size="xs"
                  disabled={isRunning}
                  value={extraArgs}
                  onChange={(e) => setExtraArgs(e.currentTarget.value)}
                  placeholder="--debug"
                />
              )}

              <Group gap="lg" wrap="wrap">
                {!config.data?.forceTrack && (
                  <Checkbox
                    size="xs"
                    label={t('run.skipUsageLogging')}
                    disabled={isRunning}
                    checked={noTrack}
                    onChange={(e) => setNoTrack(e.currentTarget.checked)}
                  />
                )}

                <Checkbox
                  size="xs"
                  label={t('run.silentMode')}
                  disabled={isRunning}
                  checked={silent}
                  onChange={(e) => setSilent(e.currentTarget.checked)}
                />

                {/* Silent already discards the report, so the narrower option is
                    redundant (and misleading) while it is on. */}
                <Tooltip label={t('run.discardReportHint')} withArrow multiline w={280}>
                  <Checkbox
                    size="xs"
                    label={t('run.discardReport')}
                    disabled={isRunning || silent}
                    checked={discardReport && !silent}
                    onChange={(e) => setDiscardReport(e.currentTarget.checked)}
                  />
                </Tooltip>
              </Group>
            </Stack>
          )}
          {gatingAlerts}
        </Paper>

        {/* Pinned action footer — stays level with the command bar on the right;
            the tag list above scrolls independently. Widths are explicit (Run
            `flex: 1`, secondary controls `flex: 'none'`) instead of Mantine
            `grow`, whose `preventGrowOverflow` cap divides the row by child
            count — with three controls that would shrink Run to a third. */}
        <Group gap="xs" style={{ flexShrink: 0 }}>
          {(() => {
            const tagsLoading = !sectionAxis && !!project && !!effectiveType && tags.isLoading;
            const disabledReason =
              missingReqs.length > 0
                ? `${t('run.missingRequirements')}: ${missingReqs.join(', ')}`
                : !project
                  ? t('run.selectProjectFirst')
                  : isRunning
                    ? t('run.testRunning')
                    : tagsLoading
                      ? t('run.loadingTags')
                      : isMobile && !appiumRunning
                        ? t('run.appiumNotRunning')
                        : null;
            return (
              <Tooltip
                label={disabledReason ?? t('run.runTooltip')}
                disabled={!disabledReason}
                withArrow
              >
                {/* Wrapper div is required so Tooltip can show on a disabled button. */}
                <div style={{ flex: 1 }}>
                  <Button
                    size="sm"
                    color="green"
                    fullWidth
                    onClick={handleRun}
                    loading={runMutation.isPending}
                    disabled={!!disabledReason}
                    leftSection={<TbPlayerPlay size={16} />}
                  >
                    {t('run.runButton')}
                  </Button>
                </div>
              </Tooltip>
            );
          })()}
          {isRunning && (
            <Button
              size="sm"
              color="red"
              onClick={handleCancel}
              leftSection={<TbPlayerStop size={16} />}
              style={{ flex: 'none' }}
            >
              {t('run.stop')}
            </Button>
          )}
          {/* Saves the same live config the Bookmarks panel captures, next to the
              form instead of in the panel at the top of the page. */}
          <Tooltip label={saveBookmarkReason ?? t('bookmark.saveCurrent')} withArrow>
            {/* Wrapper div is required so Tooltip can show on a disabled control. */}
            <div style={{ flex: 'none' }}>
              <ActionIcon
                size="lg"
                variant="default"
                onClick={handleSaveBookmark}
                loading={saveBookmark.isPending}
                disabled={!!saveBookmarkReason}
                aria-label={t('bookmark.saveCurrent')}
              >
                <TbBookmarkPlus size={18} />
              </ActionIcon>
            </div>
          </Tooltip>
        </Group>
      </Stack>

      {/* The split between the columns is a width the user sets, not a fixed
          40%. The handle is a flex item of the row — 6px wide, stretched by the
          row's own cross-axis alignment, so it adds no height of its own — and
          is hidden below `md`, where the columns wrap and each line owns the
          full width (LESS-061 §6). */}
      <Box
        visibleFrom="md"
        role="separator"
        aria-orientation="vertical"
        aria-label={`${t('run.editConfig')} / ${advancedMode ? t('run.liveOutput') : t('run.technicalOutput')}`}
        aria-valuenow={columnPercent}
        aria-valuemin={SPLIT_MIN}
        aria-valuemax={SPLIT_MAX}
        tabIndex={0}
        onPointerDown={handleDividerDown}
        onPointerMove={handleDividerMove}
        onPointerUp={handleDividerUp}
        onPointerCancel={handleDividerUp}
        onKeyDown={handleDividerKeys}
        onFocus={() => setDividerFocused(true)}
        onBlur={() => setDividerFocused(false)}
        style={{
          flex: 'none',
          width: 6,
          alignSelf: 'stretch',
          borderRadius: 'var(--mantine-radius-sm)',
          cursor: 'col-resize',
          userSelect: 'none',
          touchAction: 'none',
          background:
            dragPercent !== null || dividerFocused
              ? 'var(--mantine-color-blue-filled)'
              : 'var(--mantine-color-default-border)',
        }}
      />

      {/* Right column: terminal scrolls internally (flex:1); the bottom bar is
          pinned below it and is one button tall, like the Run/Stop footer, so
          both cards end at the same Y. With no bar to show, the terminal takes
          the whole column. */}
      <Stack
        gap="sm"
        h={{ base: '60vh', md: '100%' }}
        style={{ flex: 1, minWidth: 0, minHeight: 0 }}
      >
        <Paper
          withBorder
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          <Group
            justify="space-between"
            px="sm"
            py={6}
            style={{ borderBottom: '1px solid var(--mantine-color-default-border)', flexShrink: 0 }}
          >
            <Group gap="xs">
              <Text size="xs" c="dimmed">
                {advancedMode ? t('run.liveOutput') : t('run.technicalOutput')}
              </Text>
              {isRunning && elapsed && (
                <Text size="xs" c="blue" ff="monospace">
                  {elapsed}
                </Text>
              )}
              {isFinished && (
                <Text size="xs" fw={600} c={getStatusColor(runStatus)}>
                  {runVerdict(runSummary, t)}
                </Text>
              )}
              {!isRunning && runSummary && (
                <Group gap={6}>
                  {runSummary.passed > 0 && (
                    <Badge size="xs" color="green" variant="light">
                      {runSummary.passed} {t('run.passed')}
                    </Badge>
                  )}
                  {runSummary.failed > 0 && (
                    <Badge size="xs" color="red" variant="light">
                      {runSummary.failed} {t('run.failed')}
                    </Badge>
                  )}
                  {runSummary.skipped !== undefined && runSummary.skipped > 0 && (
                    <Badge size="xs" color="yellow" variant="light">
                      {runSummary.skipped} {t('run.skipped')}
                    </Badge>
                  )}
                </Group>
              )}
            </Group>
            <Group gap="xs">
              {advancedMode && (
                <Badge
                  size="sm"
                  color={getStatusColor(runStatus)}
                  variant={runStatus === 'running' ? 'dot' : 'filled'}
                >
                  {runStatus}
                </Badge>
              )}
              {/* One control, so the pair sits tighter than the row's gap. Both
                  ends disable at the store's clamp rather than clicking to no
                  effect. */}
              <Group gap={2} wrap="nowrap">
                <Tooltip label={`${t('run.terminalFontSize')} −`} withArrow>
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="gray"
                    onClick={() => prefs.setTerminalFontSize(fontSize - 1)}
                    disabled={fontSize <= FONT_MIN}
                    aria-label={`${t('run.terminalFontSize')} −`}
                  >
                    <TbTextDecrease size={14} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={`${t('run.terminalFontSize')} +`} withArrow>
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="gray"
                    onClick={() => prefs.setTerminalFontSize(fontSize + 1)}
                    disabled={fontSize >= FONT_MAX}
                    aria-label={`${t('run.terminalFontSize')} +`}
                  >
                    <TbTextIncrease size={14} />
                  </ActionIcon>
                </Tooltip>
              </Group>
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                onClick={() => setSearchOpen((v) => !v)}
                leftSection={<TbSearch size={12} />}
              >
                {t('run.find')}
              </Button>
            </Group>
          </Group>
          {searchOpen && (
            <Group
              px="sm"
              py={4}
              gap="xs"
              style={{
                borderBottom: '1px solid var(--mantine-color-default-border)',
                flexShrink: 0,
              }}
            >
              <TextInput
                size="xs"
                placeholder={t('run.searchOutput')}
                value={searchTerm}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  setSearchTerm(v);
                  if (v) term.findNext(v);
                  else term.clearSearch();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (e.shiftKey) term.findPrevious(searchTerm);
                    else term.findNext(searchTerm);
                  }
                  if (e.key === 'Escape') {
                    setSearchOpen(false);
                    term.clearSearch();
                  }
                }}
                leftSection={<TbSearch size={12} />}
                rightSection={
                  searchTerm ? (
                    <TbX
                      size={12}
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        setSearchTerm('');
                        term.clearSearch();
                      }}
                    />
                  ) : null
                }
                style={{ flex: 1 }}
                autoFocus
              />
              <Text size="xs" c="dimmed">
                {t('run.searchHint')}
              </Text>
            </Group>
          )}
          {/* `minWidth: 0` lets the box shrink below the grid xterm last fitted;
              without it a flex child floors at its content width and the rows
              push past the card instead of triggering a refit. */}
          <div ref={termRef} style={{ flex: 1, minWidth: 0, minHeight: 0 }} />
        </Paper>

        {/* One row of `size="sm"` controls — the same Mantine size scale as the
            Run/Stop footer, so both bars are exactly one button tall and the
            terminal card ends level with the form card. The command stays
            advanced-only and single-line (Copy carries the full value). */}
        {showRunBar && (
          <Group
            gap="xs"
            wrap="nowrap"
            justify={advancedMode ? 'space-between' : 'flex-end'}
            style={{ flexShrink: 0 }}
          >
            {advancedMode && (
              <Code
                fz="xs"
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {lastCommand}
              </Code>
            )}
            <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
              {!isRunning && elapsed && (
                <Text size="xs" c="dimmed">
                  {t('run.duration')}: {elapsed}
                </Text>
              )}
              {!isRunning && (
                <Button
                  size="sm"
                  variant="subtle"
                  onClick={handleRerun}
                  leftSection={<TbRefresh size={16} />}
                >
                  {t('run.rerun')}
                </Button>
              )}
              {advancedMode && (
                <Button
                  size="sm"
                  variant="subtle"
                  color="gray"
                  onClick={handleCopyCommand}
                  leftSection={<TbCopy size={16} />}
                >
                  {t('run.copy')}
                </Button>
              )}
            </Group>
          </Group>
        )}
      </Stack>

      <FormModal
        opened={saveModalOpen}
        onClose={() => setSaveModalOpen(false)}
        title={t('bookmark.saveCurrent')}
        submitLabel={t('common.save')}
        onSubmit={submitSaveBookmark}
        submitDisabled={!bookmarkName.trim()}
        loading={saveBookmark.isPending}
        error={saveBookmark.error?.message ?? null}
      >
        <TextInput
          label={t('bookmark.namePlaceholder')}
          placeholder={t('bookmark.namePlaceholder')}
          value={bookmarkName}
          onChange={(e) => setBookmarkName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitSaveBookmark();
          }}
          data-autofocus
        />
      </FormModal>
    </div>
  );
});
