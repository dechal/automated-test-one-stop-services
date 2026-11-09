import type {
  CustomCommand,
  HeadlessMode,
  PerformanceType,
  RunMode,
  RunRequest,
  ScheduleEntry,
  ToolId,
} from '@hub/shared';
import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Code,
  Group,
  Input,
  Modal,
  ScrollArea,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { TbCalendarTime, TbClock, TbDeviceFloppy, TbSettings } from 'react-icons/tb';
import { api } from '~/api/client.js';
import { qEnvDefault, qEnvProfilesByProject, qProjectEnv } from '~/api/queries.js';
import { BookmarkLoadModal } from '~/components/BookmarkPanel.js';
import { EnvProfileManager } from '~/components/env-profiles/EnvProfileManager.js';
import { RunStep } from '~/components/run-session/RunStep.js';
import { TagScopeControl } from '~/components/run-session/TagScopeControl.js';
import { SectionSelect } from '~/components/SectionSelect.js';
import { TagSelector } from '~/components/TagSelector.js';
import { toast } from '~/components/Toast.js';
import {
  useProjectList,
  useProjectSections,
  useProjectTags,
  useProjectTypes,
} from '~/hooks/useProjectQueries.js';
import { useTagScope } from '~/hooks/useTagScope.js';
import { useTools } from '~/hooks/useTools.js';
import { useI18nStore, useT } from '~/i18n/index.js';
import { DEFAULT_TOOL, usePreferences } from '~/stores/hub.js';
import { formatNextRun, humanizeCron } from '~/utils/cron.js';
import { buildEnvOptions, ENV_CURRENT, resolveDefaultEnv } from '~/utils/env-options.js';
import { buildPerfTypeData } from '~/utils/perf-type-options.js';
import {
  buildTagQuery,
  matchTests,
  parseTagQuery,
  type TagSelection,
} from '~/utils/tag-selection.js';
import { firstEnabledTool, toolSelectData } from '~/utils/tool-label.js';
import { fromConfigSilent, toConfigSilent } from './schedule-silent.js';

// ---------------------------------------------------------------------------
// Cron helpers
// ---------------------------------------------------------------------------

/** Pull `(?=.*@TAG)` lookaheads back into a flat tag list when editing. */
function parseTagExpression(tool: string, tag: string | undefined): TagSelection {
  return parseTagQuery(tool, tag);
}

const MODAL_WIDTH = 1180;
const MODAL_NAME_WIDTH = 320;

export interface ScheduleFormProps {
  /** When `mode === 'edit'`, a non-null schedule is required. */
  mode: 'create' | 'edit';
  /** Required for edit mode; modal stays closed when null in edit mode. */
  schedule?: ScheduleEntry | null;
  duplicateFrom?: ScheduleEntry | null;
  /** External `opened` flag for create mode (edit derives from `schedule != null`). */
  opened?: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

/**
 * One-form-fits-both Create + Edit modal for schedules. Replaces the two
 * ~250-line near-duplicate modals that used to live in `pages/Schedules.tsx`.
 *
 * The only behavioural differences between create and edit are:
 *   - initial state (defaults vs. populated from `schedule`)
 *   - HTTP verb (POST vs PUT) and URL
 *   - title and submit-button copy
 * Everything below — rendering, validation, query wiring — is identical.
 */
export function ScheduleForm({
  mode,
  schedule = null,
  duplicateFrom = null,
  opened = false,
  onClose,
  onSuccess,
}: ScheduleFormProps) {
  const isEdit = mode === 'edit';
  const isOpen = isEdit ? !!schedule : opened || !!duplicateFrom;
  const t = useT();
  const locale = useI18nStore((s) => s.locale);
  const advancedMode = usePreferences((s) => s.advancedMode);
  const cronPresets = [
    { label: t('schedule.cronHourly'), value: '0 * * * *' },
    { label: t('schedule.cron6h'), value: '0 */6 * * *' },
    { label: t('schedule.cronDaily8'), value: '0 8 * * *' },
    { label: t('schedule.cronMidnight'), value: '0 0 * * *' },
    { label: t('schedule.cronWeekdays9'), value: '0 9 * * 1-5' },
    { label: t('schedule.cronMon7'), value: '0 7 * * 1' },
  ];
  const modeOptions = [
    { value: 'local', label: t('run.modeLocal') },
    { value: 'docker', label: 'Docker' },
  ];
  const headlessOptions = [
    { value: 'headless', label: t('run.headless') },
    { value: 'headed', label: t('run.headed') },
  ];

  const defaults = {
    name: '',
    cronExpr: '0 8 * * *',
    tool: '' as ToolId,
    type: '',
    project: '',
    runMode: 'local' as RunMode,
    headless: 'headless' as HeadlessMode,
    selectedTags: [] as string[],
    extraArgs: '',
    noTrack: false,
    silent: false,
    discardReport: false,
    section: '',
    perfType: 'LOAD' as PerformanceType,
    // A new schedule is a TOOL run unless the user switches — the common case,
    // and the only kind that existed before custom schedules.
    kind: 'tool' as 'tool' | 'custom',
    script: '',
    args: '',
    cwd: '',
    envProfileId: ENV_CURRENT,
  };

  const [name, setName] = useState(defaults.name);
  const [cronExpr, setCronExpr] = useState(defaults.cronExpr);
  const [toolChoice, setTool] = useState<ToolId>(defaults.tool);
  const [type, setType] = useState(defaults.type);
  const [project, setProject] = useState(defaults.project);
  const [runMode, setRunMode] = useState<RunMode>(defaults.runMode);
  const [headless, setHeadless] = useState<HeadlessMode>(defaults.headless);
  const [selectedTags, setSelectedTags] = useState<string[]>(defaults.selectedTags);
  const [excludedTags, setExcludedTags] = useState<string[]>([]);
  const [extraArgs, setExtraArgs] = useState(defaults.extraArgs);
  const [noTrack, setNoTrack] = useState(defaults.noTrack);
  const [silent, setSilent] = useState(defaults.silent);
  const [discardReport, setDiscardReport] = useState(defaults.discardReport);
  const [section, setSection] = useState(defaults.section);
  const [perfType, setPerfType] = useState<PerformanceType>(defaults.perfType);
  const [kind, setKind] = useState<'tool' | 'custom'>(defaults.kind);
  const [script, setScript] = useState(defaults.script);
  const [args, setArgs] = useState(defaults.args);
  const [cwd, setCwd] = useState(defaults.cwd);
  const [envProfileId, setEnvProfileId] = useState(defaults.envProfileId);
  const [initializedFor, setInitializedFor] = useState<string | null>(null);
  const [duplicatedFrom, setDuplicatedFrom] = useState<string | null>(null);
  const [envManagerOpen, { open: openEnvManager, close: closeEnvManager }] = useDisclosure(false);

  // Populate state when an edit-target schedule arrives (or changes id).
  if (isEdit && schedule && initializedFor !== schedule.id) {
    setName(schedule.name);
    setCronExpr(schedule.cron);
    setTool(schedule.config.tool);
    setType(schedule.config.type);
    setProject(schedule.config.project);
    setRunMode(schedule.config.mode);
    setHeadless(schedule.config.headless ?? 'headless');
    setExtraArgs(schedule.config.extraArgs ?? '');
    setNoTrack(schedule.config.noTrack ?? false);
    setSilent(fromConfigSilent(schedule.config));
    setDiscardReport(schedule.config.discardReport ?? false);
    setSection(schedule.config.section ?? '');
    setPerfType(schedule.config.performanceType ?? 'LOAD');
    const selection = parseTagExpression(schedule.config.tool, schedule.config.tag);
    setSelectedTags(selection.include);
    setExcludedTags(selection.exclude);
    setKind(schedule.command ? 'custom' : 'tool');
    setScript(schedule.command?.script ?? defaults.script);
    setArgs(schedule.command?.args ?? defaults.args);
    setCwd(schedule.command?.cwd ?? defaults.cwd);
    setEnvProfileId(schedule.envProfileId ?? ENV_CURRENT);
    setInitializedFor(schedule.id);
  }

  if (!isEdit && duplicateFrom && duplicatedFrom !== duplicateFrom.id) {
    setName(`${duplicateFrom.name} (copy)`);
    setCronExpr(duplicateFrom.cron);
    setTool(duplicateFrom.config.tool);
    setType(duplicateFrom.config.type);
    setProject(duplicateFrom.config.project);
    setRunMode(duplicateFrom.config.mode);
    setHeadless(duplicateFrom.config.headless ?? 'headless');
    setExtraArgs(duplicateFrom.config.extraArgs ?? '');
    setNoTrack(duplicateFrom.config.noTrack ?? false);
    setSilent(fromConfigSilent(duplicateFrom.config));
    setDiscardReport(duplicateFrom.config.discardReport ?? false);
    setSection(duplicateFrom.config.section ?? '');
    setPerfType(duplicateFrom.config.performanceType ?? 'LOAD');
    const selection = parseTagExpression(duplicateFrom.config.tool, duplicateFrom.config.tag);
    setSelectedTags(selection.include);
    setExcludedTags(selection.exclude);
    setKind(duplicateFrom.command ? 'custom' : 'tool');
    setScript(duplicateFrom.command?.script ?? defaults.script);
    setArgs(duplicateFrom.command?.args ?? defaults.args);
    setCwd(duplicateFrom.command?.cwd ?? defaults.cwd);
    setEnvProfileId(duplicateFrom.envProfileId ?? ENV_CURRENT);
    setDuplicatedFrom(duplicateFrom.id);
  }

  function resetForm(): void {
    setName(defaults.name);
    setCronExpr(defaults.cronExpr);
    setTool(defaults.tool);
    setType(defaults.type);
    setProject(defaults.project);
    setRunMode(defaults.runMode);
    setHeadless(defaults.headless);
    setExtraArgs(defaults.extraArgs);
    setNoTrack(defaults.noTrack);
    setSilent(defaults.silent);
    setDiscardReport(defaults.discardReport);
    setSection(defaults.section);
    setPerfType(defaults.perfType);
    setSelectedTags(defaults.selectedTags);
    setExcludedTags([]);
    setKind(defaults.kind);
    setScript(defaults.script);
    setArgs(defaults.args);
    setCwd(defaults.cwd);
    setEnvProfileId(defaults.envProfileId);
    setInitializedFor(null);
    setDuplicatedFrom(null);
  }

  function handleClose() {
    resetForm();
    onClose();
  }

  // Tool options + per-tool project config come from the installed tools
  // (`useTools()`), not a static three-entry list. Only enabled tools are
  // schedulable.
  const { data: allTools = [] } = useTools();
  const tool: ToolId = toolChoice || firstEnabledTool(allTools, DEFAULT_TOOL);
  const toolOptions = toolSelectData(allTools);

  const types = useProjectTypes(tool);
  // Manifest-driven (replaces the `tool === 'k6'` literals): the selected tool's
  // ToolView.projects decides the type axis (effectiveType), whether a Section
  // axis exists, and therefore which controls render.
  const selectedView = allTools.find((t) => t.id === tool);
  const projectsCfg = selectedView?.projects ?? {
    depth: 1 as const,
    typeAxis: true,
    fixedType: null,
    root: 'projects',
    display: {},
    sectionAxis: false,
  };
  const sectionAxis = projectsCfg.sectionAxis;
  const effectiveType = projectsCfg.typeAxis ? type : (projectsCfg.fixedType ?? '');
  // Display (headless/headed) only applies to browser-driving project types; a
  // manifest `display` map marks each type, a missing key keeps the Select.
  const hasDisplay = projectsCfg.display?.[effectiveType] !== false;
  const supportsDocker = selectedView?.capabilities.supportsDocker ?? true;
  const effectiveRunMode: RunMode = supportsDocker ? runMode : 'local';
  const projectsQ = useProjectList(tool, effectiveType);
  const sectionsQ = useProjectSections(project, sectionAxis, tool);
  // Project .env drives the live VU counts in the perf-type labels (PEAK_VUS →
  // LOAD, MINIMAL_LOAD_VUS → MINIMAL_LOAD); only fetched for a section-axis tool.
  const projectEnvQ = useQuery(
    qProjectEnv(sectionAxis ? tool : '', effectiveType, sectionAxis ? project : ''),
  );
  const perfTypeData = buildPerfTypeData(projectEnvQ.data?.entries);
  const tags = useProjectTags(sectionAxis ? '' : tool, effectiveType, project);

  // Env profiles for the Select + the project's default for pre-selection.
  const envProfilesQ = useQuery(qEnvProfilesByProject(tool, effectiveType, project));
  const envDefaultQ = useQuery(qEnvDefault(tool, effectiveType, project));
  const envOptions = buildEnvOptions(envProfilesQ.data, t('run.envCurrent'));

  // Pre-select the project's default on a fresh (create) form once the data
  // resolves. Edit populates from the stored schedule in the init block above,
  // so only touch create (initializedFor stays null there).
  // biome-ignore lint/correctness/useExhaustiveDependencies: depend on the resolved data, not every field — mirrors the project effects.
  useEffect(() => {
    if (isEdit || duplicateFrom || !project) return;
    if (envDefaultQ.data === undefined || envProfilesQ.data === undefined) return;
    setEnvProfileId(resolveDefaultEnv(envDefaultQ.data.defaultId, envProfilesQ.data));
  }, [isEdit, duplicateFrom, project, effectiveType, tool, envDefaultQ.data, envProfilesQ.data]);

  function applyBookmarkConfig(config: RunRequest): void {
    setTool(config.tool);
    setType(config.type);
    setProject(config.project);
    setRunMode(config.mode);
    setHeadless(config.headless ?? 'headless');
    setExtraArgs(config.extraArgs ?? '');
    setNoTrack(config.noTrack ?? false);
    setSilent(fromConfigSilent(config));
    setDiscardReport(config.discardReport ?? false);
    setSection(config.section ?? '');
    setPerfType(config.performanceType ?? 'LOAD');
    const selection = parseTagExpression(config.tool, config.tag);
    setSelectedTags(selection.include);
    setExcludedTags(selection.exclude);
  }

  const tagExpr = buildTagQuery(tool, selectedTags, excludedTags);
  // Human reading of the current cron plus its next fire time. Shown as the raw
  // input's description in advanced view, and standalone under the presets in
  // simple view, where the raw input is hidden.
  const cronHuman = cronExpr ? humanizeCron(cronExpr, locale) : null;
  const cronNextRun = cronExpr ? formatNextRun(cronExpr) : null;
  const cronInvalid = Boolean(cronExpr) && (cronHuman === null || cronNextRun === null);
  const cronDescription =
    cronExpr && !cronInvalid ? `${cronHuman} · ${t('schedule.nextRun')} ${cronNextRun}` : undefined;

  const mutation = useMutation({
    mutationFn: () => {
      const config: RunRequest = {
        tool,
        type: effectiveType,
        project,
        mode: effectiveRunMode,
        tag: tagExpr,
        headless: !sectionAxis && hasDisplay ? headless : undefined,
        // Sent even while the field is hidden: a saved schedule's flags must
        // survive an edit made from the simple view.
        extraArgs: extraArgs || undefined,
        noTrack: noTrack || undefined,
        silent: toConfigSilent(silent),
        // Silent discards the report already; storing both would read as two
        // competing intents on the same schedule.
        discardReport: discardReport && !silent ? true : undefined,
        section: sectionAxis ? section || undefined : undefined,
        performanceType: sectionAxis ? perfType : undefined,
      };
      // `config` is sent for BOTH kinds: it carries the project label the schedule
      // list and history render. For a custom schedule the command is what runs.
      const command: CustomCommand | undefined =
        kind === 'custom' ? { script, args: args || undefined, cwd: cwd || undefined } : undefined;
      const body = {
        name,
        cron: cronExpr,
        config,
        envProfileId,
        ...(command ? { command } : {}),
      };
      return isEdit
        ? api.put(`/api/schedules/${schedule?.id}`, body)
        : api.post('/api/schedules', body);
    },
    onSuccess: () => {
      toast.success(isEdit ? t('schedule.updated') : t('schedule.created'));
      resetForm();
      onSuccess();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const { byTag, scope, setScope } = useTagScope({
    selectedTags,
    excludedTags,
    setSelectedTags,
    setExcludedTags,
  });

  const matchedCount = useMemo(() => {
    const tests = tags.data?.tests;
    if (sectionAxis || !tests || tests.length === 0) return null;
    const key = (x: { id: string; title: string }) => `${x.id}\u0001${x.title}`;
    return new Set(matchTests(tests, selectedTags, excludedTags).map(key)).size;
  }, [tags.data, sectionAxis, selectedTags, excludedTags]);

  const submitBase = isEdit ? t('schedule.saveSchedule') : t('schedule.createSchedule');
  const submitLabel =
    kind === 'tool' && matchedCount !== null && cronHuman && !cronInvalid
      ? `${submitBase} · ${t('schedule.saveSummary')
          .replace('{count}', matchedCount.toLocaleString())
          .replace('{when}', cronHuman)}`
      : submitBase;

  const presetChips = (
    <Group gap={6} wrap="wrap">
      {cronPresets.map((p) => (
        <Badge
          key={p.value}
          size="md"
          radius="sm"
          fw={400}
          variant={cronExpr === p.value ? 'light' : 'default'}
          style={{ cursor: 'pointer' }}
          role="button"
          tabIndex={0}
          aria-pressed={cronExpr === p.value}
          onClick={() => setCronExpr(p.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setCronExpr(p.value);
            }
          }}
        >
          {p.label}
        </Badge>
      ))}
    </Group>
  );

  return (
    <Modal
      opened={isOpen}
      onClose={handleClose}
      title={
        <Group gap={12}>
          <TbCalendarTime size={18} color="var(--mantine-color-dimmed)" />
          <Text fw={500}>{isEdit ? t('schedule.editTitle') : t('schedules.newSchedule')}</Text>
          {isEdit && name && (
            <Text size="xs" c="dimmed" ff="monospace" truncate maw={MODAL_NAME_WIDTH}>
              {name}
            </Text>
          )}
        </Group>
      }
      size={MODAL_WIDTH}
      centered
      scrollAreaComponent={ScrollArea.Autosize}
    >
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <Stack gap="md">
          <RunStep step={1} title={t('schedule.stepWhen')}>
            <SimpleGrid cols={2} spacing="sm">
              <TextInput
                label={t('webhook.name')}
                size="xs"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                placeholder={t('schedule.namePlaceholder')}
              />
              {/* The cron IS the schedule, so it is always editable. Hiding it behind
              advanced mode meant a schedule whose cron matched no preset below
              could be read (via cronDescription) but never changed — the presets
              cannot express an arbitrary expression. */}
              <TextInput
                label={t('schedule.cronExpr')}
                size="xs"
                value={cronExpr}
                onChange={(e) => setCronExpr(e.currentTarget.value)}
                placeholder="0 8 * * *"
                styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                error={cronInvalid ? t('schedule.invalidCron') : undefined}
              />
            </SimpleGrid>
            {presetChips}
            {cronDescription && (
              <Group gap={8} wrap="nowrap">
                <TbClock size={14} color="var(--mantine-color-dimmed)" />
                <Text size="xs" c="dimmed">
                  {cronDescription}
                </Text>
              </Group>
            )}
          </RunStep>

          <RunStep
            step={2}
            title={kind === 'custom' ? t('schedule.runLabelConfig') : t('run.stepTarget')}
            action={
              advancedMode ? (
                <SegmentedControl
                  size="xs"
                  value={kind}
                  onChange={(v) => setKind(v === 'custom' ? 'custom' : 'tool')}
                  disabled={isEdit}
                  data={[
                    { value: 'tool', label: t('schedules.kindTools') },
                    { value: 'custom', label: t('schedules.kindCustom') },
                  ]}
                />
              ) : undefined
            }
          >
            {kind === 'custom' && (
              <Stack gap="sm">
                <TextInput
                  label={t('schedule.customScript')}
                  description={t('schedule.customScriptHint')}
                  size="xs"
                  value={script}
                  onChange={(e) => setScript(e.currentTarget.value)}
                  placeholder="node scripts/seed.mjs"
                  styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                  error={
                    script.trim().length === 0 ? t('schedule.customScriptRequired') : undefined
                  }
                />
                <SimpleGrid cols={2} spacing="sm">
                  <TextInput
                    label={t('schedule.customArgs')}
                    size="xs"
                    value={args}
                    onChange={(e) => setArgs(e.currentTarget.value)}
                    placeholder="--rows 100"
                    styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                  />
                  <TextInput
                    label={t('schedule.customCwd')}
                    description={t('schedule.customCwdHint')}
                    size="xs"
                    value={cwd}
                    onChange={(e) => setCwd(e.currentTarget.value)}
                    placeholder="tools/k6"
                    styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                  />
                </SimpleGrid>
              </Stack>
            )}
            <SimpleGrid cols={2} spacing="sm">
              <Select
                label={t('run.tool')}
                size="xs"
                value={tool}
                onChange={(v) => {
                  if (!v) return;
                  setTool(v as ToolId);
                  setType('');
                  setProject('');
                  setSelectedTags([]);
                }}
                data={toolOptions}
                allowDeselect={false}
              />
              {projectsCfg.typeAxis && (
                <Select
                  label={t('run.type')}
                  size="xs"
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
                value={project || null}
                onChange={(v) => {
                  setProject(v ?? '');
                  setSelectedTags([]);
                }}
                placeholder={t('common.select')}
                data={projectsQ.data ?? []}
                searchable
              />
              {kind === 'tool' && (
                <Select
                  label={t('run.environment')}
                  size="xs"
                  value={envProfileId}
                  onChange={(v) => setEnvProfileId(v ?? ENV_CURRENT)}
                  data={envOptions}
                  allowDeselect={false}
                  searchable
                  disabled={!project}
                  rightSectionPointerEvents="auto"
                  rightSectionWidth={34}
                  rightSection={
                    <Tooltip label={t('run.manageEnv')} withArrow>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="gray"
                        disabled={!project}
                        onClick={(e) => {
                          e.stopPropagation();
                          openEnvManager();
                        }}
                        aria-label={t('run.manageEnv')}
                      >
                        <TbSettings size={16} />
                      </ActionIcon>
                    </Tooltip>
                  }
                />
              )}
            </SimpleGrid>
            {kind === 'tool' && (
              <Group>
                <BookmarkLoadModal
                  getConfig={() => ({
                    tool,
                    type: effectiveType,
                    project,
                    mode: effectiveRunMode,
                    tag: tagExpr,
                    headless: !sectionAxis && hasDisplay ? headless : undefined,
                    extraArgs: extraArgs || undefined,
                    noTrack: noTrack || undefined,
                    silent: toConfigSilent(silent),
                    discardReport: discardReport && !silent ? true : undefined,
                    section: sectionAxis ? section || undefined : undefined,
                    performanceType: sectionAxis ? perfType : undefined,
                  })}
                  onLoad={(config) => applyBookmarkConfig(config)}
                />
              </Group>
            )}
          </RunStep>

          <RunStep step={4} title={t('run.stepHow')}>
            <SimpleGrid cols={2} spacing="sm">
              {supportsDocker && (
                <Input.Wrapper label={t('run.mode')} size="xs">
                  <SegmentedControl
                    fullWidth
                    size="xs"
                    value={runMode}
                    onChange={(v) => setRunMode(v as RunMode)}
                    data={modeOptions}
                  />
                </Input.Wrapper>
              )}
              {!sectionAxis && hasDisplay && (
                <Input.Wrapper label={t('run.display')} size="xs">
                  <SegmentedControl
                    fullWidth
                    size="xs"
                    value={headless}
                    onChange={(v) => setHeadless(v as HeadlessMode)}
                    data={headlessOptions}
                  />
                </Input.Wrapper>
              )}
              {!sectionAxis && advancedMode && (
                <TextInput
                  label={t('run.extraArgs')}
                  size="xs"
                  value={extraArgs}
                  onChange={(e) => setExtraArgs(e.currentTarget.value)}
                  placeholder="--workers=4"
                  styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                />
              )}
            </SimpleGrid>
            <Group gap="lg" wrap="wrap">
              <Checkbox
                size="xs"
                label={t('run.skipUsageLogging')}
                checked={noTrack}
                onChange={(e) => setNoTrack(e.currentTarget.checked)}
              />
              <Checkbox
                size="xs"
                label={t('run.silentMode')}
                checked={silent}
                onChange={(e) => setSilent(e.currentTarget.checked)}
              />
              {/* The main reason this exists: a schedule that repeats daily would
                otherwise grow outputs/ forever. Silent already discards more. */}
              <Tooltip label={t('run.discardReportHint')} withArrow multiline w={280}>
                <Checkbox
                  size="xs"
                  label={t('run.discardReport')}
                  disabled={silent}
                  checked={discardReport && !silent}
                  onChange={(e) => setDiscardReport(e.currentTarget.checked)}
                />
              </Tooltip>
            </Group>
          </RunStep>
        </Stack>

        <Stack gap="md" style={{ minHeight: 0 }}>
          <RunStep
            step={3}
            title={t('run.stepTests')}
            hint={!sectionAxis && byTag && project ? t('run.tagCycleHint') : undefined}
            fill={!sectionAxis && byTag && !!project}
          >
            {sectionAxis ? (
              <SimpleGrid cols={2} spacing="sm">
                <SectionSelect
                  label={t('run.section')}
                  value={section}
                  onChange={setSection}
                  placeholder={t('common.all')}
                  sections={sectionsQ.data ?? []}
                  disabled={!project}
                />
                <Select
                  label={t('run.perfType')}
                  size="xs"
                  value={perfType}
                  onChange={(v) => v && setPerfType(v as PerformanceType)}
                  data={perfTypeData}
                  allowDeselect={false}
                />
              </SimpleGrid>
            ) : (
              <>
                <TagScopeControl
                  value={scope}
                  onChange={setScope}
                  totalTests={tags.data?.tests?.length ?? 0}
                  disabled={!project}
                />
                {byTag && project && (
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
                {advancedMode && selectedTags.length > 0 && (
                  <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                    {t('schedule.tagExpr')} <Code>{tagExpr}</Code>
                  </Text>
                )}
              </>
            )}
          </RunStep>
        </Stack>
      </SimpleGrid>

      {mutation.isError && (
        <Text size="sm" c="red" mt="sm">
          {(mutation.error as Error).message}
        </Text>
      )}

      <Group
        justify="space-between"
        gap="xs"
        mt="md"
        pt="md"
        style={{
          position: 'sticky',
          bottom: 0,
          background: 'var(--mantine-color-body)',
          borderTop: '1px solid var(--mantine-color-default-border)',
        }}
      >
        <Button variant="subtle" color="gray" onClick={handleClose} size="sm">
          {t('common.cancel')}
        </Button>
        <Button
          color="green.8"
          onClick={() => mutation.mutate()}
          disabled={!name || !project || !cronExpr}
          loading={mutation.isPending}
          size="sm"
          leftSection={<TbDeviceFloppy size={16} />}
        >
          {submitLabel}
        </Button>
      </Group>

      {kind === 'tool' && project && (
        <Modal
          opened={envManagerOpen}
          onClose={closeEnvManager}
          title={t('envProfiles.title')}
          size="lg"
          centered
          scrollAreaComponent={ScrollArea.Autosize}
        >
          <EnvProfileManager tool={tool} type={effectiveType} project={project} />
        </Modal>
      )}
    </Modal>
  );
}
