import type { QueryClient } from '@tanstack/react-query';
import {
  createHashHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';
import { qActiveRuns, qDoctor, qProjects, qRunsHistory } from './api/queries.js';
import { queryClient } from './api/query-client.js';
import { AppLayout } from './components/AppLayout.js';
import { PageLoader } from './components/PageLoader.js';
import { GridSkeleton, ListSkeleton, StatCardsSkeleton } from './components/Skeletons.js';

function DashboardPending() {
  return (
    <>
      <StatCardsSkeleton />
      <ListSkeleton />
    </>
  );
}

function GridPending() {
  return <GridSkeleton />;
}

function ListPending() {
  return <ListSkeleton />;
}

// ---------------------------------------------------------------------------
// Router context — gives every route loader access to the shared QueryClient
// so it can `ensureQueryData` before the page component mounts.
// ---------------------------------------------------------------------------

interface RouterContext {
  queryClient: QueryClient;
}

// ---------------------------------------------------------------------------
// Root layout route
// ---------------------------------------------------------------------------

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: AppLayout,
});

// ---------------------------------------------------------------------------
// Page routes — code-split via lazyRouteComponent
// ---------------------------------------------------------------------------

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  // Prefetch the three dashboard queries in parallel at navigation time so the
  // page renders with data already in cache (no render-then-fetch waterfall).
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(qDoctor());
    void context.queryClient.prefetchQuery(qProjects());
    void context.queryClient.prefetchQuery(qRunsHistory());
  },
  component: lazyRouteComponent(() => import('./pages/Dashboard.js'), 'DashboardPage'),
  pendingComponent: DashboardPending,
});

const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/run',
  // Run page gates on whether any projects exist and reconnects to active runs.
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(qProjects());
    void context.queryClient.prefetchQuery(qActiveRuns());
  },
  component: lazyRouteComponent(() => import('./pages/Run.js'), 'RunPage'),
  pendingComponent: ListPending,
});

const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/history',
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(qRunsHistory());
  },
  component: lazyRouteComponent(() => import('./pages/History.js'), 'HistoryPage'),
  pendingComponent: ListPending,
});

const schedulesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/schedules',
  component: lazyRouteComponent(() => import('./pages/Schedules.js'), 'SchedulesPage'),
  pendingComponent: ListPending,
});

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  component: lazyRouteComponent(() => import('./pages/Projects.js'), 'ProjectsPage'),
  pendingComponent: ListPending,
});

const envProfilesRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/env-profiles',
  beforeLoad: () => {
    throw redirect({ to: '/projects' });
  },
  pendingComponent: ListPending,
});

const reportsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reports',
  component: lazyRouteComponent(() => import('./pages/Reports.js'), 'ReportsPage'),
  pendingComponent: ListPending,
});

const artifactsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/artifacts',
  component: lazyRouteComponent(() => import('./pages/Artifacts.js'), 'ArtifactsPage'),
  pendingComponent: GridPending,
});

const insightsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/insights',
  component: lazyRouteComponent(() => import('./pages/Insights.js'), 'InsightsPage'),
  pendingComponent: ListPending,
});

const dockerRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/docker',
  beforeLoad: () => {
    throw redirect({ to: '/settings' });
  },
  pendingComponent: GridPending,
});

const webhooksRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/webhooks',
  beforeLoad: () => {
    throw redirect({ to: '/settings' });
  },
  pendingComponent: ListPending,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: lazyRouteComponent(() => import('./pages/Settings.js'), 'SettingsPage'),
  pendingComponent: ListPending,
});

// Contextual view (no nav item): reached from History by selecting two runs.
// The two run ids ride as ?a=&b= search params.
export const compareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/compare',
  validateSearch: (search: Record<string, unknown>): { a?: string; b?: string } => ({
    a: typeof search.a === 'string' ? search.a : undefined,
    b: typeof search.b === 'string' ? search.b : undefined,
  }),
  component: lazyRouteComponent(() => import('./pages/Compare.js'), 'ComparePage'),
  pendingComponent: ListPending,
});

const testcasesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/testcases',
  component: lazyRouteComponent(() => import('./pages/Testcases.js'), 'TestCasesPage'),
  pendingComponent: ListPending,
});

// ---------------------------------------------------------------------------
// Route tree & router
// ---------------------------------------------------------------------------

const routeTree = rootRoute.addChildren([
  dashboardRoute,
  runRoute,
  historyRoute,
  compareRoute,
  schedulesRoute,
  projectsRoute,
  testcasesRoute,
  envProfilesRedirectRoute,
  reportsRoute,
  artifactsRoute,
  insightsRoute,
  dockerRedirectRoute,
  webhooksRedirectRoute,
  settingsRoute,
]);

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultPreload: 'intent',
  // Let React Query own caching/staleness: setting the router's own preload
  // stale time to 0 means loaders always re-run `ensureQueryData`, which is a
  // cache hit when the query is still fresh per its own `staleTime`.
  defaultPreloadStaleTime: 0,
  // Without a pending fallback the router paints nothing while the initial
  // route's loaders resolve — a blank dark page that looks like the app failed
  // to load. Render a loader instead, and with `defaultPendingMs: 0` show it
  // immediately rather than after the 1s default (navigations are local cache
  // hits, so this won't flash on route changes).
  defaultPendingComponent: () => <PageLoader boot />,
  defaultPendingMs: 150,
  defaultPendingMinMs: 0,
  context: { queryClient },
});

export function preloadAllRouteChunks(): void {
  for (const route of router.routeTree.children ?? []) {
    void router.loadRouteChunk(route);
  }
}

// Type-safe router declaration
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
