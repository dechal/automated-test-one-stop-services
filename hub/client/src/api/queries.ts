import type {
  CoverageReport,
  DoctorReport,
  EnvFile,
  HubUser,
  ProjectSummary,
  RunRecord,
  TagsResponse,
  TestCaseDoc,
  TestCaseDocGrouped,
  TestCaseGrid,
  TestCaseModule,
  TestTrendReport,
  ToolId,
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

/** The Hub's local user identity (`user: null` until a name has been set). */
export const qHubUser = () =>
  queryOptions({
    queryKey: ['hub-user'] as const,
    queryFn: () => api.get<{ user: HubUser | null }>('/api/user'),
    staleTime: STALE.moderate,
  });
