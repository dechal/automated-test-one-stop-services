/**
 * RunSession orchestrates the run/config state for one session. The imperative
 * terminal (xterm) and WebSocket plumbing now live in `useRunTerminal` and
 * `useRunSocket`. The effects that remain here intentionally omit the stable
 * `prefs` store from their deps (persisting / prefilling last-used tool, type,
 * and project) — including it would re-run them on unrelated preference changes.
 * The file-level ignore documents that these omissions are deliberate.
 */
// biome-ignore-all lint/correctness/useExhaustiveDependencies: remaining effects intentionally omit the stable prefs store; see note above.
import type { RunMode, RunRecord, RunRequest, RunStatus, ToolId } from '@hub/shared';
import { missingChecksForTool } from '@hub/shared';
import { ActionIcon, Box, Group, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { useDisclosure, useHotkeys } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { TbChevronDown, TbChevronUp } from 'react-icons/tb';
import { api } from '~/api/client.js';
import {
  qAppiumStatus,
  qConfig,
  qDoctor,
  qEnvDefault,
  qEnvProfilesByProject,
  qProjectEnv,
  qRunReport,
  queryRoots,
} from '~/api/queries.js';
import { useSaveBookmark } from '~/components/BookmarkPanel.js';
import { confirmDialog } from '~/components/confirmDialog.js';
import { EnvDrawer } from '~/components/env-profiles/EnvDrawer.js';
import { RunActionFooter } from '~/components/run-session/RunActionFooter.js';
import { RunGatingAlerts } from '~/components/run-session/RunGatingAlerts.js';
import { RunMoreOptions } from '~/components/run-session/RunMoreOptions.js';
import { RunResultBar } from '~/components/run-session/RunResultBar.js';
import { RunTargetFields } from '~/components/run-session/RunTargetFields.js';
import { RunTerminalToolbar } from '~/components/run-session/RunTerminalToolbar.js';
import {
  SPLIT_IDLE_FORM,
  SPLIT_MAX,
  SPLIT_MIN,
  SPLIT_STEP,
} from '~/components/run-session/run-session-constants.js';
import { SaveBookmarkModal } from '~/components/run-session/SaveBookmarkModal.js';
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
import { recordingTerminal, useRunSessions, useSessionField } from '~/stores/navigation.js';
import { buildEnvOptions, ENV_CURRENT, resolveDefaultEnv } from '~/utils/env-options.js';
import { buildPerfTypeData } from '~/utils/perf-type-options.js';
import { mergeExtraArgs, parseRunArgs, SUPPORTS_RUN_FLAGS } from '~/utils/run-flags.js';
import { buildTagQuery, parseTagQuery } from '~/utils/tag-selection.js';
import { enabledTools, toolLabel } from '~/utils/tool-label.js';

const TERMINAL_RESET = '\x1b[H\x1b[2J\x1b[3J';

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

  const restoredRef = useRef(useRunSessions.getState().sessions[sessionId] !== undefined);
  const [tool, setTool] = useSessionField(sessionId, 'tool', initialConfig?.tool ?? prefs.lastTool);
  const [mode, setMode] = useSessionField(
    sessionId,
    'mode',
    initialConfig?.mode ?? prefs.defaultMode,
  );
  const [type, setType] = useSessionField(sessionId, 'type', initialConfig?.type ?? '');
  const [project, setProject] = useSessionField(sessionId, 'project', initialConfig?.project ?? '');
  // Env is session form state, NOT part of RunRequest/currentConfig: a manual
  // run applies the profile before spawn and stores nothing (a deleted profile
  // id must never land in a permanent record — same reason as the schedule
  // column). `__current__` means "run with the project's .env on disk".
  const [envProfileId, setEnvProfileId] = useSessionField(sessionId, 'envProfileId', ENV_CURRENT);
  const [envDefaultFor, setEnvDefaultFor] = useSessionField(sessionId, 'envDefaultFor', '');
  const [envDrawerOpen, { open: openEnvDrawer, close: closeEnvDrawer }] = useDisclosure(false);
  const initialSelection = parseTagQuery(initialConfig?.tool ?? '', initialConfig?.tag);
  const [selectedTags, setSelectedTags] = useSessionField(
    sessionId,
    'selectedTags',
    initialSelection.include,
  );
  const [excludedTags, setExcludedTags] = useSessionField(
    sessionId,
    'excludedTags',
    initialSelection.exclude,
  );
  const [headless, setHeadless] = useSessionField(
    sessionId,
    'headless',
    initialConfig?.headless ?? prefs.defaultHeadless,
  );
  // Saved configs store the composed argument string, so split it back apart to
  // hydrate the typed fields (round-trip pair — brain LESS-073).
  const initialArgs = parseRunArgs(initialConfig?.extraArgs);
  const [extraArgs, setExtraArgs] = useSessionField(sessionId, 'extraArgs', initialArgs.rest);
  const [workers, setWorkers] = useSessionField(sessionId, 'workers', initialArgs.workers ?? null);
  const [repeatEach, setRepeatEach] = useSessionField(
    sessionId,
    'repeatEach',
    initialArgs.repeatEach ?? null,
  );

  // Skip usage logging defaults ON: the Google Sheet log is opt-in for most runs,
  // so a fresh session should not write to it unless the user asks. A saved
  // config still wins, so bookmarks/reconnect keep their captured intent.
  const [noTrack, setNoTrack] = useSessionField(
    sessionId,
    'noTrack',
    initialConfig?.noTrack ?? true,
  );
  const [silent, setSilent] = useSessionField(sessionId, 'silent', initialConfig?.silent ?? false);
  const [discardReport, setDiscardReport] = useSessionField(
    sessionId,
    'discardReport',
    initialConfig?.discardReport ?? false,
  );
  // Open the HTML report automatically once the run finishes, so the user does
  // not switch to the Reports page. A form-only preference (not part of
  // RunRequest), meaningful only when a report survives the run — i.e. not
  // silent and not discardReport.
  const [autoOpenReport, setAutoOpenReport] = useSessionField(sessionId, 'autoOpenReport', false);
  const [section, setSection] = useSessionField(sessionId, 'section', initialConfig?.section ?? '');
  const [perfType, setPerfType] = useSessionField(
    sessionId,
    'perfType',
    initialConfig?.performanceType ?? 'LOAD',
  );

  const [runStatus, setRunStatus] = useSessionField(sessionId, 'runStatus', 'idle');
  const [activeRunId, setActiveRunId] = useSessionField(sessionId, 'activeRunId', null);
  const [lastCommand, setLastCommand] = useSessionField(sessionId, 'lastCommand', '');
  const [startTime, setStartTime] = useSessionField(sessionId, 'startTime', null);
  const [elapsed, setElapsed] = useSessionField(sessionId, 'elapsed', '');
  const [runSummary, setRunSummary] = useSessionField(sessionId, 'runSummary', null);
  const [lastRequest, setLastRequest] = useSessionField(sessionId, 'lastRequest', null);
  const [reconnectTarget] = useState<{ runId: string; command: string } | null>(() => {
    if (!restoredRef.current) {
      return reconnectRunId ? { runId: reconnectRunId, command: reconnectCommand ?? '' } : null;
    }
    const inFlight = runStatus === 'running' || runStatus === 'pending';
    return inFlight && activeRunId ? { runId: activeRunId, command: lastCommand } : null;
  });
  const fullOutputRef = useRef('');
  const activeRunIdRef = useRef<string | null>(activeRunId);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const moreOpen = prefs.runMoreOpen;
  const toggleMore = () => prefs.setRunMoreOpen(!prefs.runMoreOpen);
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
  const idleFormPercent = Math.max(splitPercent, SPLIT_IDLE_FORM);
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
  const { termRef, term: rawTerm } = useRunTerminal({
    visible,
    refitKey: `${runStatus}|${showRunBar}|${searchOpen}|${splitPercent}`,
    fontSize,
  });
  const term = useMemo(() => recordingTerminal(rawTerm, sessionId), [rawTerm, sessionId]);
  const { send } = useRunSocket({
    term,
    activeRunIdRef,
    fullOutputRef,
    setRunStatus,
    setRunSummary,
    setActiveRunId,
    setLastCommand,
    reconnectRunId: reconnectTarget?.runId,
    reconnectCommand: reconnectTarget?.command,
    t,
  });

  useEffect(() => {
    if (!restoredRef.current) return;
    const transcript = useRunSessions.getState().transcripts[sessionId];
    if (!transcript) return;
    rawTerm.write(`${TERMINAL_RESET}${transcript}`);
  }, []);

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

  const config = useQuery(qConfig());

  // Full doctor report (shares the ['doctor'] cache with the Dashboard panel).
  // Drives both the credentials notice and the per-tool run-requirement gate.
  const doctorQ = useQuery(qDoctor());

  // Force mode to local if Docker is not running
  useEffect(() => {
    if (config.data && !config.data.dockerRunning && mode === 'docker') {
      setMode('local');
    }
  }, [config.data, mode]);

  // Derive the selected tool's project axes from its manifest (via useTools),
  // replacing hardcoded `tool === 'k6'` branches so any portable tool works.
  const toolsQuery = useTools();
  const installedTools = enabledTools(toolsQuery.data ?? []);
  useEffect(() => {
    if (installedTools.length === 0) return;
    if (installedTools.some((t) => t.id === tool)) return;
    const fallback = installedTools[0];
    if (!fallback) return;
    setTool(fallback.id as ToolId);
    setType('');
    setProject('');
    setSelectedTags([]);
    setExcludedTags([]);
  }, [installedTools, tool]);
  const toolView = (toolsQuery.data ?? []).find((t) => t.id === tool);
  const sectionAxis = toolView?.projects.sectionAxis ?? false;
  const typeAxis = toolView?.projects.typeAxis ?? true;
  const fixedType = toolView?.projects.fixedType ?? null;
  const effectiveType = typeAxis ? type : (fixedType ?? '');
  // Display (headless/headed) only applies to project types that drive a
  // browser. A manifest `display` map marks each type; a missing key means the
  // type keeps the Select (older manifests behave exactly as before).
  const display = toolView?.projects.display;
  const hasDisplay = display?.[effectiveType] !== false;
  /** Fields actually rendered in the options row — drives its column count. */
  const optionFieldCount =
    (advancedMode ? 1 : 0) +
    (!sectionAxis && hasDisplay ? 1 : 0) +
    (!sectionAxis && supportsRunFlags ? 2 : 0);

  // Run-requirement gate: doctor checks this tool needs but that are missing
  // (e.g. Robot → uv, python). Blocks Run up-front and lists exactly what to
  // install, so the user never launches a doomed run.
  const missingReqs =
    toolView && doctorQ.data ? missingChecksForTool(toolView, doctorQ.data.checks) : [];

  const types = useProjectTypes(tool);
  const projectsQ = useProjectList(tool, effectiveType);
  const sectionsQ = useProjectSections(project, sectionAxis, tool);
  // Project .env drives the live VU counts shown in the perf-type labels
  // (PEAK_VUS → LOAD, MINIMAL_LOAD_VUS → MINIMAL_LOAD); only fetched for a
  // section-axis tool (k6), where the perf-type Select is shown.
  const projectEnvQ = useQuery(
    qProjectEnv(sectionAxis ? tool : '', effectiveType, sectionAxis ? project : ''),
  );
  const perfTypeData = buildPerfTypeData(projectEnvQ.data?.entries);
  const supportsTags = (toolView?.capabilities.tagsStrategy ?? 'none') !== 'none';
  const tags = useProjectTags(supportsTags ? tool : '', effectiveType, project);

  // Env profiles + the project's default, for the Select and its pre-selection.
  const envProfilesQ = useQuery(qEnvProfilesByProject(tool, effectiveType, project));
  const envDefaultQ = useQuery(qEnvDefault(tool, effectiveType, project));
  const envOptions = buildEnvOptions(envProfilesQ.data, t('run.envCurrent'));

  // Pre-select the project's default profile once the list + default resolve.
  // Parallel to the last-used-project effect; falls back to __current__.
  useEffect(() => {
    if (!project) {
      setEnvProfileId(ENV_CURRENT);
      setEnvDefaultFor('');
      return;
    }
    if (envDefaultQ.data === undefined || envProfilesQ.data === undefined) return;
    const resolved = resolveDefaultEnv(envDefaultQ.data.defaultId, envProfilesQ.data);
    const signature = [
      tool,
      effectiveType,
      project,
      resolved,
      ...envProfilesQ.data.map((p) => p.id),
    ].join('|');
    if (signature === envDefaultFor) return;
    setEnvDefaultFor(signature);
    setEnvProfileId(resolved);
  }, [project, effectiveType, tool, envDefaultQ.data, envProfilesQ.data]);

  // One line of what a run will use, read from the same live state
  // `currentConfig()` submits: the axes that decide a run's identity, in the
  // order their fields appear in the expanded form.
  const configSummary = [
    toolLabel(tool, toolsQuery.data ?? []),
    sectionAxis ? section : effectiveType,
    project || t('run.selectProjectFirst'),
    !sectionAxis && hasDisplay ? (headless === 'headed' ? t('run.headed') : t('run.headless')) : '',
  ]
    .filter(Boolean)
    .join(' · ');

  // Mobile (Robot type=mobile) needs the host Appium server running. Gate the
  // Run button on it and offer a one-click start (Option A: host appium).
  const isMobile = effectiveType === 'mobile';
  const appiumQ = useQuery({
    ...qAppiumStatus(isMobile),
    refetchInterval: isMobile ? 5000 : false,
  });
  const appiumRunning = appiumQ.data?.running ?? false;
  const startAppium = useMutation({
    mutationFn: () => api.post('/api/appium/start'),
    onSuccess: () => {
      toast.success(t('run.appiumStarting'));
      queryClient.invalidateQueries({ queryKey: [queryRoots.appiumStatus] });
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
    <RunGatingAlerts
      credentialsMissing={credentialsMissing}
      missingReqs={missingReqs}
      appiumMissing={appiumMissing}
      onCredentialsUploaded={() => doctorQ.refetch()}
      onStartAppium={() => startAppium.mutate()}
      startAppiumPending={startAppium.isPending}
      startAppiumDisabled={appiumQ.data ? !appiumQ.data.installed : false}
    />
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
      setLastRequest(record.request);
      fullOutputRef.current = '';
      term.clear();
      term.writeln(`\x1b[32m[Started]\x1b[0m Run ${record.id}`);
      term.writeln(`\x1b[90m$ ${record.command}\x1b[0m\n`);
      send({ kind: 'subscribe', runId: record.id, replay: true });
      queryClient.invalidateQueries({ queryKey: [queryRoots.queue] });
      queryClient.invalidateQueries({ queryKey: [queryRoots.activeRuns] });
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
      headless: !sectionAxis && hasDisplay ? headless : undefined,
      extraArgs: effectiveExtraArgs,
      noTrack,
      silent,
      // Silent discards the report already, so never send both — the stored
      // config then reads as exactly one intent.
      discardReport: discardReport && !silent,
      envProfileId: envProfileId !== ENV_CURRENT ? envProfileId : undefined,
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

  async function handleRun() {
    const tagExpr = buildTagQuery(tool, selectedTags, excludedTags);
    const effectiveNoTrack = config.data?.forceTrack ? false : noTrack;
    runMutation.mutate({
      tool,
      type: effectiveType,
      project,
      mode: effectiveMode,
      tag: tagExpr,
      headless: !sectionAxis && hasDisplay ? headless : undefined,
      extraArgs: effectiveExtraArgs,
      noTrack: effectiveNoTrack,
      silent,
      discardReport: discardReport && !silent,
      envProfileId: envProfileId !== ENV_CURRENT ? envProfileId : undefined,
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
    const request = runMutation.data?.request ?? lastRequest;
    if (request) runMutation.mutate(request);
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

  // A report survives the run only when it is neither silent nor discarded, so
  // the "open after finish" option is offered only then; it is force-off in the
  // other cases so a stale check cannot fire an open on a report that is gone.
  const reportSurvives = !silent && !(discardReport && !silent);
  const reportRunId = runMutation.data?.id ?? activeRunId;

  // Resolve the finished run's report path (and favourite flag) on demand. The
  // runner never writes RunRecord.reportPath, so the server matches it from the
  // reports listing — see GET /api/runs/:id/report. Only queried once the run
  // has finished and could have left a report.
  const reportQuery = useQuery({
    ...qRunReport(reportRunId),
    enabled: isFinished && reportSurvives && !!reportRunId,
  });
  const reportPath = reportQuery.data?.reportPath;

  async function handleSeeReport(): Promise<void> {
    if (!reportPath) return;
    try {
      await api.post('/api/reports/open-file', { path: reportPath });
    } catch {
      toast.error(t('runlog.openReportFailed'));
    }
  }

  async function handleRevealReport(): Promise<void> {
    if (!reportPath) return;
    try {
      await api.post('/api/system/reveal', { path: reportPath });
    } catch (err) {
      toast.error((err as Error).message || t('run.revealReportFailed'));
    }
  }

  async function handleDeleteReport(): Promise<void> {
    if (!reportPath) return;
    const ok = await confirmDialog({
      title: t('reports.deleteTitle'),
      message: t('reports.cannotUndo'),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/api/reports?path=${encodeURIComponent(reportPath)}`);
      toast.success(t('reports.reportDeleted'), {
        id: `report-del-${reportRunId}-${Date.now()}`,
      });
      queryClient.removeQueries({ queryKey: qRunReport(reportRunId).queryKey });
      queryClient.invalidateQueries({ queryKey: ['reports'] });
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      toast.error(code === 'REPORT_LOCKED' ? t('reports.deleteLocked') : t('reports.deleteFailed'));
    }
  }

  // Open the report once per finished run when the user asked for it. Keyed on
  // the run id so a rerun (new id) can open again, and guarded by a ref so a
  // query refetch does not reopen the same report.
  const autoOpenedRunRef = useRef<string | null>(
    restoredRef.current && isFinished ? activeRunId : null,
  );
  useEffect(() => {
    if (!autoOpenReport || !reportPath || !reportRunId) return;
    if (autoOpenedRunRef.current === reportRunId) return;
    autoOpenedRunRef.current = reportRunId;
    void handleSeeReport();
  }, [autoOpenReport, reportPath, reportRunId]);

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
        w={{
          base: '100%',
          md: `${runStatus === 'idle' && dragPercent === null ? idleFormPercent : columnPercent}%`,
        }}
        h={{ base: 'auto', md: '100%' }}
        style={{ flexShrink: 0, minHeight: 0 }}
      >
        <Paper
          p="xs"
          withBorder
          style={{
            opacity: isRunning ? 0.85 : 1,
            // Natural height in BOTH states, shrinking — and scrolling inside
            // itself — only on a viewport too short to hold the fields. Expanded
            // used to be `flex: 1`, which grew the card into whatever space was
            // left: on a 900px viewport the fields ended ~450px above the card's
            // own bottom edge, so the page showed a large empty BORDERED box,
            // which reads as broken rather than spacious. The slack now sits in
            // the spacer below, as plain background. The reasoning that already
            // justified `0 1 auto` for the collapsed state applies just as well
            // expanded.
            flex: '0 1 auto',
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
              <RunTargetFields
                isRunning={isRunning}
                collapseToggle={collapseToggle}
                typeAxis={typeAxis}
                sectionAxis={sectionAxis}
                supportsTags={supportsTags}
                tools={toolsQuery.data ?? []}
                tool={tool}
                setTool={setTool}
                type={type}
                setType={setType}
                typesData={types.data}
                project={project}
                setProject={setProject}
                projectsData={projectsQ.data}
                projectsLoading={projectsQ.isLoading}
                envProfileId={envProfileId}
                setEnvProfileId={setEnvProfileId}
                envOptions={envOptions}
                openEnvDrawer={openEnvDrawer}
                section={section}
                setSection={setSection}
                sections={sectionsQ.data ?? []}
                perfType={perfType}
                setPerfType={setPerfType}
                perfTypeData={perfTypeData}
                tagsData={tags.data}
                tagsLoading={tags.isLoading}
                selectedTags={selectedTags}
                setSelectedTags={setSelectedTags}
                excludedTags={excludedTags}
                setExcludedTags={setExcludedTags}
              />

              <RunMoreOptions
                moreOpen={moreOpen}
                toggleMore={toggleMore}
                isRunning={isRunning}
                advancedMode={advancedMode}
                optionFieldCount={optionFieldCount}
                dockerRunning={config.data?.dockerRunning}
                forceTrack={config.data?.forceTrack}
                sectionAxis={sectionAxis}
                hasDisplay={hasDisplay}
                supportsRunFlags={supportsRunFlags}
                reportSurvives={reportSurvives}
                mode={mode}
                setMode={setMode}
                headless={headless}
                setHeadless={setHeadless}
                workers={workers}
                setWorkers={setWorkers}
                repeatEach={repeatEach}
                setRepeatEach={setRepeatEach}
                extraArgs={extraArgs}
                setExtraArgs={setExtraArgs}
                noTrack={noTrack}
                setNoTrack={setNoTrack}
                silent={silent}
                setSilent={setSilent}
                discardReport={discardReport}
                setDiscardReport={setDiscardReport}
                autoOpenReport={autoOpenReport}
                setAutoOpenReport={setAutoOpenReport}
              />
            </Stack>
          )}
          {gatingAlerts}
        </Paper>

        {/* Takes the slack the form card no longer grows into, so the footer below
            stays pinned to the bottom of the column. This is what keeps Run in a
            fixed place: a repeatable control must not move between clicks, and
            collapsing or expanding the form must not relocate it (UX checklist
            §2). Empty background here, not an empty bordered card. */}
        <div style={{ flex: 1, minHeight: 0 }} aria-hidden />

        {/* Pinned action footer — stays level with the command bar on the right;
            the tag list above scrolls independently. Widths are explicit (Run
            `flex: 1`, secondary controls `flex: 'none'`) instead of Mantine
            `grow`, whose `preventGrowOverflow` cap divides the row by child
            count — with three controls that would shrink Run to a third. */}
        <RunActionFooter
          supportsTags={supportsTags}
          project={project}
          effectiveType={effectiveType}
          tagsIsLoading={tags.isLoading}
          missingReqs={missingReqs}
          isRunning={isRunning}
          isMobile={isMobile}
          appiumRunning={appiumRunning}
          handleRun={handleRun}
          runPending={runMutation.isPending}
          handleCancel={handleCancel}
          saveBookmarkReason={saveBookmarkReason}
          handleSaveBookmark={handleSaveBookmark}
          saveBookmarkPending={saveBookmark.isPending}
        />
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
          <RunTerminalToolbar
            advancedMode={advancedMode}
            isRunning={isRunning}
            isFinished={isFinished}
            elapsed={elapsed}
            runStatus={runStatus}
            runSummary={runSummary}
            fontSize={fontSize}
            setTerminalFontSize={prefs.setTerminalFontSize}
            splitPercent={splitPercent}
            setRunSplitPercent={prefs.setRunSplitPercent}
            searchOpen={searchOpen}
            setSearchOpen={setSearchOpen}
            searchTerm={searchTerm}
            setSearchTerm={setSearchTerm}
            term={term}
          />
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
          <RunResultBar
            advancedMode={advancedMode}
            isRunning={isRunning}
            lastCommand={lastCommand}
            elapsed={elapsed}
            reportPath={reportPath}
            reportFavorite={reportQuery.data?.favorite}
            handleCopyCommand={handleCopyCommand}
            handleSeeReport={handleSeeReport}
            handleRevealReport={handleRevealReport}
            handleDeleteReport={handleDeleteReport}
            handleRerun={handleRerun}
          />
        )}
      </Stack>

      <SaveBookmarkModal
        opened={saveModalOpen}
        onClose={() => setSaveModalOpen(false)}
        onSubmit={submitSaveBookmark}
        bookmarkName={bookmarkName}
        setBookmarkName={setBookmarkName}
        loading={saveBookmark.isPending}
        error={saveBookmark.error?.message ?? null}
      />

      <EnvDrawer
        opened={envDrawerOpen}
        onClose={closeEnvDrawer}
        tool={tool}
        type={effectiveType}
        project={project}
      />
    </div>
  );
});
