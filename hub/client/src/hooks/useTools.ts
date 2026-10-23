import type {
  LifecycleResult,
  ManifestPreview,
  ProvisionResult,
  PythonInstallResult,
  ToolView,
} from '@hub/shared';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '~/api/client.js';
import { qToolRegistry, qTools, queryRoots } from '~/api/queries.js';

/**
 * Every query whose results depend on WHICH tools are enabled/installed.
 * Enabling/disabling/installing/uninstalling a tool changes what these
 * endpoints return, so they must all be invalidated together — otherwise a
 * page like Reports or Artifacts keeps showing a now-disabled tool's data
 * until the user manually refreshes.
 */
const TOOL_DEPENDENT_KEYS: readonly (readonly string[])[] = [
  [queryRoots.tools],
  [queryRoots.projects],
  ['reports'],
  ['artifacts'],
  [queryRoots.runsHistory],
  [queryRoots.runsLastStatus],
  [queryRoots.bookmarks],
  [queryRoots.schedules],
  [queryRoots.webhooks],
  [queryRoots.envProfiles],
];

/**
 * Invalidate every tool-dependent query. Active queries (the current page)
 * refetch immediately; inactive ones are marked stale and refetch the next
 * time their page is opened — so switching menus always shows fresh data.
 */
function invalidateToolDependent(qc: QueryClient): void {
  for (const key of TOOL_DEPENDENT_KEYS) {
    qc.invalidateQueries({ queryKey: key });
  }
}

/** Fetches the list of discovered tools (GET /api/tools). */
export function useTools() {
  return useQuery(qTools());
}

/**
 * Select-ready options ({ value, label }) derived from the installed+enabled
 * tools. Replaces the hardcoded `[{ value: 'playwright', ... }]` lists that were
 * scattered across filter/config pages so the UI always reflects what is
 * actually installed.
 */
export function useToolOptions(): { value: string; label: string }[] {
  const { data } = useTools();
  return (data ?? [])
    .filter((t) => t.status === 'enabled')
    .map((t) => ({ value: t.id, label: t.title }));
}

/** Mutation to toggle a tool's enabled state (POST /api/tools/:id/enable or /disable). */
export function useToggleTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.post<LifecycleResult<ToolView>>(`/api/tools/${id}/${enabled ? 'enable' : 'disable'}`),
    onSuccess: () => invalidateToolDependent(qc),
  });
}

/** Fetches registry entries for the marketplace view.
 *  Pass `enabled` (e.g. the modal's open state) so the registry — which probes
 *  remote git URLs server-side — is only fetched when actually needed, not on
 *  every Projects page load. */
export function useRegistry(enabled = true) {
  return useQuery(qToolRegistry(enabled));
}

/** Two-phase install: step 1 (dry-run) returns ManifestPreview. */
export function useInstallTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<ManifestPreview>('/api/tools/install', { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [queryRoots.toolRegistry] });
    },
  });
}

/** Two-phase install: step 2 (confirmed) returns LifecycleResult<ToolView>. */
export function useConfirmInstall() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.post<LifecycleResult<ToolView>>('/api/tools/install', { name, confirm: true }),
    onSuccess: () => {
      invalidateToolDependent(qc);
      qc.invalidateQueries({ queryKey: [queryRoots.toolRegistry] });
    },
  });
}

/** Uninstall a tool (project-count guard enforced server-side). */
export function useUninstallTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<LifecycleResult<{ removed: string }>>(`/api/tools/${id}/uninstall`),
    onSuccess: () => invalidateToolDependent(qc),
  });
}

/** Update a registry-installed tool to a new ref. */
export function useUpdateTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ref }: { id: string; ref?: string }) =>
      api.post<LifecycleResult<{ from: string; to: string }>>(`/api/tools/${id}/update`, { ref }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [queryRoots.tools] });
    },
  });
}

/**
 * (Re-)provision a tool's browsers/binary by re-running its `setup` task
 * (POST /api/tools/:id/provision). Mirrors `useToggleTool`'s mutation pattern.
 * On success, invalidates the doctor + tools queries so the Environment Status
 * panel re-probes and reflects the freshly provisioned state. The mutation
 * always resolves (even when provisioning failed in-band: `{ ok: false,
 * postInstallError }`); callers read `data.ok` / `data.postInstallError` to
 * render guidance.
 */
export function useProvisionTool() {
  const qc = useQueryClient();
  return useMutation({
    // Provisioning runs the tool's `setup` task server-side (browser download
    // for Playwright), which can take minutes — the server caps it at 180s. The
    // global 30s axios timeout would abort early with a false "timeout of
    // 30000ms" while the install is still running, so use a long per-request
    // timeout that outlasts the server cap.
    mutationFn: (id: string) =>
      api.post<ProvisionResult>(`/api/tools/${id}/provision`, undefined, { timeout: 300_000 }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [queryRoots.doctor] });
      qc.invalidateQueries({ queryKey: [queryRoots.tools] });
    },
  });
}

/**
 * Retroactively install the Python toolchain that setup skipped
 * (POST /api/doctor/install-python). Backs the Doctor panel's "Install Python"
 * button. The install can download a CPython build + sync deps, so it uses a
 * long per-request timeout (the global axios default is far too short). The
 * mutation always resolves; callers read `data.ok` / `data.error` / `data.message`
 * to render the outcome. On completion both doctor queries are invalidated so the
 * panel and the nav badge re-probe.
 */
export function useInstallPython() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<PythonInstallResult>('/api/doctor/install-python', undefined, {
        timeout: 300_000,
      }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: [queryRoots.doctor] });
    },
  });
}

/**
 * Re-scan the workspace (POST /api/workspace/resync) and regenerate the derived
 * config files. Needed after a project or tool is added outside the Hub — a
 * `git clone` into `tools/`, a copied project folder — because the Hub's caches
 * and the generated tsconfig/compose files do not know about it yet.
 */
export function useResyncWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ regeneratedFiles: string[] }>('/api/workspace/resync'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [queryRoots.tools] });
      qc.invalidateQueries({ queryKey: [queryRoots.projects] });
    },
  });
}
