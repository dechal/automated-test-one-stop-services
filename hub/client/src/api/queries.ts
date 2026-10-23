import type {
  AppiumStatus,
  Bookmark,
  BookmarkWithStatus,
  CoverageReport,
  CredentialStatus,
  DockerStatus,
  DoctorReport,
  EnvFile,
  EnvProfile,
  EnvProfileValidation,
  FlakyReport,
  HubUser,
  K6TrendData,
  ProjectSummary,
  QueueStatus,
  RunCompareResult,
  RunRecord,
  ScheduleEntry,
  TagsResponse,
  TestCaseDoc,
  TestCaseDocGrouped,
  TestCaseGrid,
  TestCaseModule,
  TestTrendReport,
  ToolId,
  ToolRegistryView,
  ToolView,
  UsageLoggingStatus,
  WebhookConfig,
} from '@hub/shared';
import { queryOptions } from '@tanstack/react-query';
import { api } from '~/api/client.js';

/**
 * Centralized query-options factory.
 *
 * Each entry is a `queryOptions()` object — the single source of truth for a
 * query's key, fetcher, and tuning. Components call `useQuery(qProjects())`
 * and route loaders call `queryClient.ensureQueryData(qProjects())`, so both
 * read and write the *same* cache entry. Previously these keys/fetchers were
 * re-declared inline in every page, which risked key drift (broken
 * invalidation) and made it impossible for a loader to prefetch what a page
 * would later request.
 *
 * Why `queryOptions()` over plain objects: it ties the `queryKey` to the
 * `queryFn` return type, so `useQuery(qDoctor()).data` is `DoctorReport`
 * without a manual generic, and `invalidateQueries` calls are key-checked.
 */

/**
 * Staleness tiers (ms). The Hub mutates its own data through the API and
 * invalidates the affected query keys on success, so background refetching
 * only needs to catch changes made *outside* the Hub. Setting a `staleTime`
 * therefore cuts the refetch-on-mount / refetch-on-focus churn that a local
 * single-user tool does not need (default `staleTime: 0` refetches every time).
 */
const STALE = {
  /** Structural axes that change only when a project is created/cloned/removed. */
  structural: 5 * 60_000,
  /** Lists that change when a run finishes or a project/env is edited in the Hub. */
  moderate: 60_000,
  /** Data that can also change from outside the Hub (specs, env files on disk). */
  short: 30_000,
} as const;

// ---------------------------------------------------------------------------
// Dashboard / global axis
// ---------------------------------------------------------------------------

export const qDoctor = () =>
  queryOptions({
    queryKey: ['doctor'] as const,
    queryFn: () => api.get<DoctorReport>('/api/doctor'),
    staleTime: 10_000,
  });

export const qProjects = () =>
  queryOptions({
    queryKey: ['projects'] as const,
    queryFn: () => api.get<ProjectSummary[]>('/api/projects'),
    staleTime: STALE.moderate,
  });

export const qRunsHistory = () =>
  queryOptions({
    queryKey: ['runs-history'] as const,
    queryFn: () => api.get<RunRecord[]>('/api/runs/history'),
    staleTime: STALE.short,
  });

// Active runs are the live axis — keep the default (always refetch on mount) so
// a reconnecting page never shows a stale "running" that has already finished.
export const qActiveRuns = () =>
  queryOptions({
    queryKey: ['activeRuns'] as const,
    queryFn: () => api.get<RunRecord[]>('/api/runs/active'),
  });

// ---------------------------------------------------------------------------
// Project axis (tool / type / project) — shared by Run, EnvProfiles, etc.
// ---------------------------------------------------------------------------

/** All project names across every tool/type. */
export const qAllProjects = () =>
  queryOptions({
    queryKey: ['allProjects'] as const,
    queryFn: () => api.get<string[]>('/api/projects/list'),
    staleTime: STALE.moderate,
  });

export const qProjectTypes = (tool: ToolId | undefined | '') =>
  queryOptions({
    queryKey: ['types', tool] as const,
    queryFn: () => api.get<string[]>(`/api/projects/types?tool=${tool}`),
    enabled: !!tool,
    staleTime: STALE.structural,
    gcTime: Number.POSITIVE_INFINITY,
  });

/** k6 forces type=performance — caller passes that effective type. */
export const qProjectList = (tool: ToolId | undefined | '', type: string | undefined | '') =>
  queryOptions({
    queryKey: ['projectList', tool, type] as const,
    queryFn: () => api.get<string[]>(`/api/projects/list?tool=${tool}&type=${type}`),
    enabled: !!tool && !!type,
    staleTime: STALE.structural,
    gcTime: Number.POSITIVE_INFINITY,
  });

/** Used by k6 only — sections under `automations/specs/<section>/`. */
export const qProjectSections = (project: string | undefined | '', enabled = true, tool?: string) =>
  queryOptions({
    queryKey: ['sections', project, tool ?? ''] as const,
    queryFn: () =>
      api.get<string[]>(`/api/projects/sections?project=${project}${tool ? `&tool=${tool}` : ''}`),
    enabled: enabled && !!project,
    staleTime: STALE.structural,
    gcTime: Number.POSITIVE_INFINITY,
  });

export const qProjectTags = (
  tool: ToolId | undefined | '',
  type: string | undefined | '',
  project: string | undefined | '',
) =>
  queryOptions({
    queryKey: ['tags', tool, type, project] as const,
    queryFn: () => api.get<TagsResponse>(`/api/tags?tool=${tool}&type=${type}&project=${project}`),
    enabled: !!tool && !!type && !!project,
    staleTime: STALE.short,
  });

/**
 * Project `.env` contents (key/value entries). Used by the Element Picker to
 * prefill the URL field from a selected project's `BASE_URL` entry. Enabled
 * only once a full tool/type/project axis is chosen.
 */
export const qProjectEnv = (
  tool: ToolId | undefined | '',
  type: string | undefined | '',
  project: string | undefined | '',
) =>
  queryOptions({
    queryKey: ['projectEnv', tool, type, project] as const,
    queryFn: () =>
      api.get<EnvFile>(`/api/env/project?tool=${tool}&type=${type}&project=${project}`),
    enabled: !!tool && !!type && !!project,
    staleTime: STALE.short,
  });

// ---------------------------------------------------------------------------
// Test-case documents
// ---------------------------------------------------------------------------

/** Coverage for every project with documented cases — grouped client-side. */
export const qAllCoverage = () =>
  queryOptions({
    queryKey: ['coverage-all'] as const,
    queryFn: () => api.get<CoverageReport[]>('/api/coverage/all'),
    staleTime: STALE.short,
  });

/** Documented test-case coverage vs latest run outcome for one project. */
export const qCoverage = (
  tool: ToolId | undefined | '',
  type: string | undefined | '',
  project: string | undefined | '',
) =>
  queryOptions({
    queryKey: ['coverage', tool, type, project] as const,
    queryFn: () =>
      api.get<CoverageReport>(`/api/coverage?tool=${tool}&type=${type}&project=${project}`),
    enabled: !!tool && !!type && !!project,
    staleTime: STALE.short,
  });

/** Per-test trends for every project that has any — grouped client-side. */
export const qAllTestTrends = () =>
  queryOptions({
    queryKey: ['test-trends-all'] as const,
    queryFn: () => api.get<TestTrendReport[]>('/api/test-trends/all'),
    staleTime: STALE.short,
  });

/** Per-test pass-rate + flakiness trend for one Playwright project. */
export const qTestTrends = (
  tool: ToolId | undefined | '',
  type: string | undefined | '',
  project: string | undefined | '',
) =>
  queryOptions({
    queryKey: ['test-trends', tool, type, project] as const,
    queryFn: () =>
      api.get<TestTrendReport>(`/api/test-trends?tool=${tool}&type=${type}&project=${project}`),
    enabled: !!tool && !!type && !!project,
    staleTime: STALE.short,
  });

/** Every test-case doc across all tools/types/projects, tagged with its axis. */
export const qAllTestCaseDocs = () =>
  queryOptions({
    queryKey: ['testcases-all'] as const,
    queryFn: () => api.get<TestCaseDocGrouped[]>('/api/testcases/all'),
    staleTime: STALE.short,
  });

/** Test-case docs (xlsx/csv) discovered under one project. */
export const qTestCaseDocs = (
  tool: ToolId | undefined | '',
  type: string | undefined | '',
  project: string | undefined | '',
) =>
  queryOptions({
    queryKey: ['testcases', tool, type, project] as const,
    queryFn: () =>
      api.get<TestCaseDoc[]>(`/api/testcases?tool=${tool}&type=${type}&project=${project}`),
    enabled: !!tool && !!type && !!project,
    staleTime: STALE.short,
  });

/** A project's modules and which of them already own a test-case doc. */
export const qTestCaseModules = (
  tool: ToolId | undefined | '',
  type: string | undefined | '',
  project: string | undefined | '',
) =>
  queryOptions({
    queryKey: ['testcase-modules', tool, type, project] as const,
    queryFn: () =>
      api.get<TestCaseModule[]>(
        `/api/testcases/modules?tool=${tool}&type=${type}&project=${project}`,
      ),
    enabled: !!tool && !!type && !!project,
    staleTime: STALE.short,
  });

/**
 * One doc as an editable grid. Left at the default `staleTime: 0` on purpose —
 * a run writes synced results into the doc's overlay behind the Hub's back, so
 * reopening the editor must always show what is actually on disk.
 */
export const qTestCaseGrid = (docPath: string) =>
  queryOptions({
    queryKey: ['tc-grid', docPath] as const,
    queryFn: () => api.get<TestCaseGrid>(`/api/testcases/grid?path=${encodeURIComponent(docPath)}`),
  });

// ---------------------------------------------------------------------------
// Env profiles (tool / type / project)
// ---------------------------------------------------------------------------

/**
 * Env profiles for one project. The key `['env-profiles', tool, type, project]`
 * matches the inline query `EnvProfiles.tsx` used before this factory existed,
 * so the page and the run-page Drawer read the SAME cache entry.
 */
export const qEnvProfilesByProject = (
  tool: ToolId | undefined | '',
  type: string | undefined | '',
  project: string | undefined | '',
) =>
  queryOptions({
    queryKey: ['env-profiles', tool, type, project] as const,
    queryFn: () =>
      api.get<EnvProfile[]>(
        `/api/env-profiles/by-project?tool=${tool}&type=${type}&project=${project}`,
      ),
    enabled: !!tool && !!type && !!project,
    staleTime: STALE.moderate,
  });

/** Id of the project's default profile (or `null`) — drives the Select pre-select. */
export const qEnvDefault = (
  tool: ToolId | undefined | '',
  type: string | undefined | '',
  project: string | undefined | '',
) =>
  queryOptions({
    queryKey: ['env-profiles-default', tool, type, project] as const,
    queryFn: () =>
      api.get<{ defaultId: string | null }>(
        `/api/env-profiles/default?tool=${tool}&type=${type}&project=${project}`,
      ),
    enabled: !!tool && !!type && !!project,
    staleTime: STALE.moderate,
  });

/** Key-sync validation of one profile against its `.env.template`. */
export const qEnvValidate = (id: string | undefined | '') =>
  queryOptions({
    queryKey: ['env-profiles-validate', id] as const,
    queryFn: () => api.get<EnvProfileValidation>(`/api/env-profiles/validate?id=${id}`),
    enabled: !!id,
    staleTime: STALE.short,
  });

/** The Hub's local user identity (`user: null` until a name has been set). */
export const qHubUser = () =>
  queryOptions({
    queryKey: ['hub-user'] as const,
    queryFn: () => api.get<{ user: HubUser | null }>('/api/user'),
    staleTime: STALE.moderate,
  });

/**
 * Canonical root segment of every query key. Factories spread the right root in
 * as their key's first element and callers invalidate by `queryRoots.x` instead
 * of a re-typed literal, so a key can never drift from the string that owns its
 * cache entry (a mistyped literal silently drops invalidation).
 */
export const queryRoots = {
  doctor: 'doctor',
  projects: 'projects',
  runsHistory: 'runs-history',
  activeRuns: 'activeRuns',
  allProjects: 'allProjects',
  types: 'types',
  projectList: 'projectList',
  sections: 'sections',
  tags: 'tags',
  projectEnv: 'projectEnv',
  coverageAll: 'coverage-all',
  coverage: 'coverage',
  testTrendsAll: 'test-trends-all',
  testTrends: 'test-trends',
  testcasesAll: 'testcases-all',
  testcases: 'testcases',
  testcaseModules: 'testcase-modules',
  tcGrid: 'tc-grid',
  envProfiles: 'env-profiles',
  envProfilesDefault: 'env-profiles-default',
  envProfilesActive: 'env-profiles-active',
  envProfilesTemplate: 'env-profiles-template',
  envProfilesValidate: 'env-profiles-validate',
  hubUser: 'hub-user',
  bookmarks: 'bookmarks',
  flaky: 'flaky',
  queue: 'queue',
  credentials: 'credentials',
  tools: 'tools',
  toolRegistry: 'tool-registry',
  usageLogging: 'usage-logging',
  compare: 'compare',
  dockerStatus: 'docker-status',
  appiumStatus: 'appium-status',
  k6Trends: 'k6-trends',
  gitStatus: 'git-status',
  runsLastStatus: 'runs-last-status',
  env: 'env',
  config: 'config',
  runReport: 'run-report',
  schedules: 'schedules',
  concurrency: 'concurrency',
  retention: 'retention',
  cleanupHistory: 'cleanup-history',
  webhooks: 'webhooks',
} as const;

// ---------------------------------------------------------------------------
// Lists invalidated from the Hub itself (bookmarks, schedules, webhooks, queue)
// ---------------------------------------------------------------------------

/** Saved run configs. Annotated with stale-tag status by the server. */
export const qBookmarks = () =>
  queryOptions({
    queryKey: [queryRoots.bookmarks] as const,
    queryFn: () => api.get<BookmarkWithStatus[]>('/api/bookmarks'),
  });

export const qBookmarkList = () =>
  queryOptions({
    queryKey: [queryRoots.bookmarks, 'list'] as const,
    queryFn: () => api.get<Bookmark[]>('/api/bookmarks?annotate=0'),
  });

/** Every cron schedule (tool + custom). */
export const qSchedules = () =>
  queryOptions({
    queryKey: [queryRoots.schedules] as const,
    queryFn: () => api.get<ScheduleEntry[]>('/api/schedules'),
  });

/** Every configured outbound webhook. */
export const qWebhooks = () =>
  queryOptions({
    queryKey: [queryRoots.webhooks] as const,
    queryFn: () => api.get<WebhookConfig[]>('/api/webhooks'),
  });

/** Live run queue — the poll interval is the caller's (idle vs active). */
export const qQueue = () =>
  queryOptions({
    queryKey: [queryRoots.queue] as const,
    queryFn: () => api.get<QueueStatus>('/api/queue'),
  });

/** Flaky-test report across every project. */
export const qFlaky = () =>
  queryOptions({
    queryKey: [queryRoots.flaky] as const,
    queryFn: () => api.get<FlakyReport>('/api/flaky'),
  });

// ---------------------------------------------------------------------------
// Env-profile side axes (active / template) — list + default live above
// ---------------------------------------------------------------------------

/** Id of the profile currently applied to the project's `.env` (or `null`). */
export const qEnvProfilesActive = (
  tool: ToolId | undefined | '',
  type: string | undefined | '',
  project: string | undefined | '',
) =>
  queryOptions({
    queryKey: [queryRoots.envProfilesActive, tool, type, project] as const,
    queryFn: () =>
      api.get<{ activeId: string | null }>(
        `/api/env-profiles/active?tool=${tool}&type=${type}&project=${project}`,
      ),
    enabled: !!tool && !!type && !!project,
  });

/** The project's `.env.template` key/value map — drives the key-sync feedback. */
export const qEnvProfilesTemplate = (
  tool: ToolId | undefined | '',
  type: string | undefined | '',
  project: string | undefined | '',
  enabled = true,
) =>
  queryOptions({
    queryKey: [queryRoots.envProfilesTemplate, tool, type, project] as const,
    queryFn: () =>
      api.get<Record<string, string>>(
        `/api/env-profiles/template?tool=${tool}&type=${type}&project=${project}`,
      ),
    enabled: enabled && !!tool && !!type && !!project,
  });

// ---------------------------------------------------------------------------
// System status probes (docker / appium / credentials / tools / usage logging)
// ---------------------------------------------------------------------------

/** Docker Desktop + compose-service status. Caller owns the poll interval. */
export const qDockerStatus = () =>
  queryOptions({
    queryKey: [queryRoots.dockerStatus] as const,
    queryFn: () => api.get<DockerStatus>('/api/docker/status'),
  });

/** Host Appium server status. `enabled`/poll owned by the caller. */
export const qAppiumStatus = (enabled = true) =>
  queryOptions({
    queryKey: [queryRoots.appiumStatus] as const,
    queryFn: () => api.get<AppiumStatus>('/api/appium/status'),
    enabled,
  });

/** Tools that declare a credentials folder, with upload readiness. */
export const qCredentials = () =>
  queryOptions({
    queryKey: [queryRoots.credentials] as const,
    queryFn: () => api.get<{ tools: CredentialStatus[] }>('/api/credentials'),
    staleTime: 15_000,
  });

/** Discovered + enabled tools. */
export const qTools = () =>
  queryOptions({
    queryKey: [queryRoots.tools] as const,
    queryFn: () => api.get<readonly ToolView[]>('/api/tools'),
    staleTime: 15_000,
  });

/** Marketplace registry — probes remote git, so fetched only when `enabled`. */
export const qToolRegistry = (enabled = true) =>
  queryOptions({
    queryKey: [queryRoots.toolRegistry] as const,
    queryFn: () => api.get<ToolRegistryView>('/api/tool-registry'),
    staleTime: 60_000,
    enabled,
  });

/** Usage-logging (Google Sheet) readiness + toggle state. */
export const qUsageLogging = () =>
  queryOptions({
    queryKey: [queryRoots.usageLogging] as const,
    queryFn: () => api.get<UsageLoggingStatus>('/api/usage-logging/status'),
    staleTime: 15_000,
  });

// ---------------------------------------------------------------------------
// Run axes (compare / k6 trends / last status / active-run report)
// ---------------------------------------------------------------------------

/** Diff of two runs (A vs B). Enabled once both ids are present. */
export const qCompare = (a: string | undefined | '', b: string | undefined | '') =>
  queryOptions({
    queryKey: [queryRoots.compare, a, b] as const,
    queryFn: () => api.get<RunCompareResult>(`/api/runs/compare?a=${a}&b=${b}`),
    enabled: !!a && !!b,
  });

/** k6 per-project performance trend data. */
export const qK6Trends = () =>
  queryOptions({
    queryKey: [queryRoots.k6Trends] as const,
    queryFn: () => api.get<K6TrendData[]>('/api/k6-trends'),
  });

/** Latest run status per `tool/type/project` key (Projects page badges). */
export const qRunsLastStatus = () =>
  queryOptions({
    queryKey: [queryRoots.runsLastStatus] as const,
    queryFn: () =>
      api.get<Record<string, { status: string; endedAt: string }>>('/api/runs/last-status'),
  });

/**
 * The finished run's report path + favourite flag. Left at the default
 * `staleTime: 0`; the caller gates it with `enabled` once the run has finished.
 */
export const qRunReport = (runId: string | undefined | null) =>
  queryOptions({
    queryKey: [queryRoots.runReport, runId] as const,
    queryFn: () => api.get<{ reportPath: string; favorite: boolean }>(`/api/runs/${runId}/report`),
    enabled: !!runId,
    retry: false,
    meta: { silentError: true },
  });

// ---------------------------------------------------------------------------
// Settings / environment axes (concurrency / retention / cleanup / env / config)
// ---------------------------------------------------------------------------

/** Run concurrency ceiling + current active/queued counts. */
export const qConcurrency = () =>
  queryOptions({
    queryKey: [queryRoots.concurrency] as const,
    queryFn: () =>
      api.get<{ maxConcurrency: number; activeCount: number; queueLength: number }>(
        '/api/runs/concurrency',
      ),
  });

/** Output-retention policy (days + auto-cleanup flag). */
export const qRetention = () =>
  queryOptions({
    queryKey: [queryRoots.retention] as const,
    queryFn: () =>
      api.get<{ retentionDays: number; autoCleanup: boolean }>('/api/system/retention'),
  });

/** Past cleanup runs (manual + auto). */
export const qCleanupHistory = () =>
  queryOptions({
    queryKey: [queryRoots.cleanupHistory] as const,
    queryFn: () =>
      api.get<
        Array<{
          timestamp: string;
          deleted: number;
          total: number;
          retentionDays: number;
          trigger: 'manual' | 'auto';
        }>
      >('/api/system/cleanup-history'),
  });

/** The editing target for {@link qEnv}: `scripts/.env` or one project `.env`. */
export interface EnvTarget {
  tool: ToolId | 'scripts';
  type: string;
  project: string;
}

const EMPTY_ENV_FILE: EnvFile = {
  path: '',
  exists: false,
  hasTemplate: false,
  entries: [],
  missingKeys: [],
};

/**
 * One `.env` file's entries — `scripts/.env` or a project `.env`, keyed by the
 * editing target so switching targets reads a distinct cache entry. Left at the
 * default `staleTime: 0`; the caller gates it with `enabled`.
 */
export const qEnv = (target: EnvTarget | null, enabled = true) =>
  queryOptions({
    queryKey: [queryRoots.env, target] as const,
    queryFn: () => {
      if (!target) return Promise.resolve(EMPTY_ENV_FILE);
      if (target.tool === 'scripts') return api.get<EnvFile>('/api/env/scripts');
      return api.get<EnvFile>(
        `/api/env/project?tool=${target.tool}&type=${target.type}&project=${target.project}`,
      );
    },
    enabled,
  });

/**
 * Run-page config flags (`forceTrack`, `dockerRunning`). Stable within a
 * session, so it never refetches on mount/focus once fetched.
 */
export const qConfig = () =>
  queryOptions({
    queryKey: [queryRoots.config] as const,
    queryFn: () => api.get<{ forceTrack: boolean; dockerRunning: boolean }>('/api/config'),
    gcTime: Number.POSITIVE_INFINITY,
    staleTime: Number.POSITIVE_INFINITY,
  });

/**
 * Git status (ahead/behind per repo). Left at the default `staleTime: 0` to
 * match today's inline query; the Projects page adds its own poll + focus
 * refetch. (d1j tightens this against a server-side cache.)
 */
export const qGitStatus = () =>
  queryOptions({
    queryKey: [queryRoots.gitStatus] as const,
    staleTime: 4 * 60_000,
    queryFn: () =>
      api.get<{
        items: Array<{
          project: string;
          tool: string;
          type: string;
          branch: string;
          localHash: string;
          remoteHash: string;
          hasUpdate: boolean;
          error?: string;
        }>;
        anyUpdate: boolean;
      }>('/api/git/status'),
  });
