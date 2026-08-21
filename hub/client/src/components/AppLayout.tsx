import type { RunRequest } from '@hub/shared';
import {
  ActionIcon,
  AppShell,
  Badge,
  Burger,
  Center,
  Divider,
  Group,
  Indicator,
  Kbd,
  NavLink,
  ScrollArea,
  Switch,
  Text,
  Title,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { useDisclosure, useHotkeys, useMediaQuery } from '@mantine/hooks';
import { spotlight } from '@mantine/spotlight';
import { useQuery } from '@tanstack/react-query';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { Suspense, useCallback, useState } from 'react';
import {
  TbAdjustmentsHorizontal,
  TbBrandDocker,
  TbCalendarTime,
  TbChartBar,
  TbChartLine,
  TbChecklist,
  TbChevronDown,
  TbChevronRight,
  TbFolderFilled,
  TbHistory,
  TbKey,
  TbLayoutSidebarLeftCollapse,
  TbLayoutSidebarLeftExpand,
  TbPhoto,
  TbPlayerPlay,
  TbReportAnalytics,
  TbSettings,
} from 'react-icons/tb';
import { qActiveRuns, qDoctor } from '~/api/queries.js';
import { ActiveRunsBanner } from '~/components/ActiveRunsBanner.js';
import { ErrorBoundary } from '~/components/ErrorBoundary.js';
import { FloatingRunsWindow } from '~/components/FloatingRunsWindow.js';
import { KeyboardShortcuts } from '~/components/KeyboardShortcuts.js';
import { LanguageToggle } from '~/components/LanguageToggle.js';
import { NotificationCenter } from '~/components/NotificationCenter.js';
import { PageLoader } from '~/components/PageLoader.js';
import { SpotlightSearch } from '~/components/SpotlightSearch.js';
import { UserNameGate } from '~/components/UserNameGate.js';
import { useRunFinishedNotifier } from '~/hooks/useRunFinishedNotifier.js';
import { useScheduleToasts } from '~/hooks/useScheduleToasts.js';
import type { TranslationKey } from '~/i18n/en';
import { useT } from '~/i18n/index.js';
import { usePreferences } from '~/stores/hub.js';
import { useNavigationStore } from '~/stores/navigation.js';

// ---------------------------------------------------------------------------
// Nav structure
// ---------------------------------------------------------------------------

type PagePath =
  | '/'
  | '/run'
  | '/history'
  | '/schedules'
  | '/projects'
  | '/testcases'
  | '/env-profiles'
  | '/reports'
  | '/artifacts'
  | '/insights'
  | '/docker'
  | '/webhooks'
  | '/settings';

interface NavItem {
  path: PagePath;
  labelKey: TranslationKey;
  descKey: TranslationKey;
  icon: React.ReactNode;
  /**
   * Advanced-only ITEM inside an otherwise basic category. Hidden from the navbar
   * in simple mode, and it keeps its category (moving it into an `advanced`
   * category would file it under the wrong heading). ⌘K still reaches it, exactly
   * like the items in `advanced` categories.
   */
  advanced?: boolean;
}

interface NavCategory {
  labelKey: TranslationKey;
  /** When true the whole category is tucked behind the "Advanced" toggle. */
  advanced?: boolean;
  items: NavItem[];
}

const NAV_CATEGORIES: NavCategory[] = [
  {
    labelKey: 'nav.workspace',
    items: [
      {
        path: '/',
        labelKey: 'nav.dashboard',
        descKey: 'nav.dashboard.desc',
        icon: <TbChartBar size={18} />,
      },
      {
        path: '/run',
        labelKey: 'nav.runTests',
        descKey: 'nav.runTests.desc',
        icon: <TbPlayerPlay size={18} />,
      },
      {
        path: '/reports',
        labelKey: 'nav.reports',
        descKey: 'nav.reports.desc',
        icon: <TbReportAnalytics size={18} />,
      },
      {
        path: '/history',
        labelKey: 'nav.history',
        descKey: 'nav.history.desc',
        icon: <TbHistory size={18} />,
      },
      {
        path: '/schedules',
        labelKey: 'nav.schedules',
        descKey: 'nav.schedules.desc',
        icon: <TbCalendarTime size={18} />,
        // Cron expressions + custom shell commands are operator surfaces.
        advanced: true,
      },
    ],
  },
  {
    labelKey: 'nav.manage',
    items: [
      {
        path: '/projects',
        labelKey: 'nav.projects',
        descKey: 'nav.projects.desc',
        icon: <TbFolderFilled size={18} />,
      },
      {
        path: '/testcases',
        labelKey: 'nav.testCases',
        descKey: 'nav.testCases.desc',
        icon: <TbChecklist size={18} />,
      },
      {
        path: '/artifacts',
        labelKey: 'nav.artifacts',
        descKey: 'nav.artifacts.desc',
        icon: <TbPhoto size={18} />,
      },
    ],
  },
  {
    labelKey: 'nav.insights',
    items: [
      {
        path: '/insights',
        labelKey: 'nav.insights',
        descKey: 'nav.insights.desc',
        icon: <TbChartLine size={18} />,
      },
    ],
  },
  {
    // Operator-only surfaces: a raw `.env` key/value editor and the container
    // services. Both need engineering context, so they share one gated group.
    labelKey: 'nav.infrastructure',
    advanced: true,
    items: [
      {
        path: '/env-profiles',
        labelKey: 'nav.envProfiles',
        descKey: 'nav.envProfiles.desc',
        icon: <TbKey size={18} />,
      },
      {
        path: '/docker',
        labelKey: 'nav.docker',
        descKey: 'nav.docker.desc',
        icon: <TbBrandDocker size={18} />,
      },
    ],
  },
];

/** Pinned below the categories: reached from every page, never scrolled away. */
const SETTINGS_ITEM: NavItem = {
  path: '/settings',
  labelKey: 'nav.settings',
  descKey: 'nav.settings.desc',
  icon: <TbSettings size={18} />,
};

// ---------------------------------------------------------------------------
// Layout component
// ---------------------------------------------------------------------------

/** Max content width. Caps line length on ultrawide screens; pages still go
 * full width below this. One knob to widen/narrow every page at once. */
const CONTENT_MAX_WIDTH = 1600;

/** Navbar widths. 240px is a fifth of a 1200px screen, so the rail trades the
 * labels — already covered by ⌘K — for ~180px of content, keeping only the
 * icons and the two live status badges. */
const NAVBAR_WIDTH = 240;
const RAIL_WIDTH = 64;

export function AppLayout() {
  const t = useT();
  const navigate = useNavigate();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname as PagePath;

  const theme = useMantineTheme();

  const [opened, { toggle, close }] = useDisclosure();
  const [floatingOpen, setFloatingOpen] = useState(false);
  const advancedMode = usePreferences((s) => s.advancedMode);
  const setAdvancedMode = usePreferences((s) => s.setAdvancedMode);
  const navRailCollapsed = usePreferences((s) => s.navRailCollapsed);
  const setNavRailCollapsed = usePreferences((s) => s.setNavRailCollapsed);
  // The rail only applies where the navbar is a static column. Below the
  // AppShell breakpoint it is the burger drawer, which keeps its labels because
  // tooltips are unreachable on touch.
  const staticNavbar = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true, {
    getInitialValueInEffect: false,
  });
  const rail = navRailCollapsed && staticNavbar;
  // Editors bind the sidebar to mod+B, so the muscle memory already exists; the
  // header button advertises it in its tooltip rather than hiding it.
  useHotkeys([['mod+B', () => setNavRailCollapsed(!navRailCollapsed)]]);
  // Manual collapse state of the advanced nav group. `null` means "follow the
  // advanced-mode preference"; flipping the preference resets it to null so the
  // group re-opens with the mode, while a hand collapse still sticks.
  const [advancedNavOpen, setAdvancedNavOpen] = useState<boolean | null>(null);
  const showAdvanced = advancedNavOpen ?? advancedMode;
  const setPendingRunConfig = useNavigationStore((s) => s.setPendingRunConfig);

  // App-level Corner_Toast listener for `schedule-finished`.
  // Surfaces schedule completion toasts on any page; ephemeral, never persisted.
  useScheduleToasts();

  // Global running indicator
  const activeRuns = useQuery({
    ...qActiveRuns(),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && data.length > 0 ? 3000 : 30_000;
    },
  });
  const runningCount = activeRuns.data?.length ?? 0;

  // App-level desktop notification for interactive run completion, so a run that
  // finishes while the user is on another page still raises an OS notification.
  useRunFinishedNotifier(activeRuns.data ?? []);

  // Doctor status for the nav badge. Reuses the shared `qDoctor()` options so
  // the layout and the Dashboard share a single cache entry / fetch for
  // /api/doctor instead of each keeping its own (['doctor'] vs ['doctor-nav']).
  const doctorQ = useQuery(qDoctor());
  const envUnhealthy = doctorQ.data ? !doctorQ.data.overallOk : false;

  function navigateTo(path: PagePath) {
    navigate({ to: path });
    close();
  }

  // Quick run from spotlight
  const handleQuickRun = useCallback(
    (config: RunRequest) => {
      setPendingRunConfig(config);
      navigate({ to: '/run' });
    },
    [navigate, setPendingRunConfig],
  );

  // Spotlight navigation adapter (accepts string page names for backward compat)
  const handleSpotlightNavigate = useCallback(
    (page: string) => {
      const path = page === 'dashboard' ? '/' : (`/${page}` as PagePath);
      navigate({ to: path });
      close();
    },
    [navigate, close],
  );

  const handleSpotlightBookmark = useCallback(
    (config: RunRequest) => {
      handleQuickRun(config);
    },
    [handleQuickRun],
  );

  /** The two live status badges: the running count on Run, the doctor alert on
   * the Dashboard. `text` names the status for assistive tech and for the hover,
   * since a colour alone carries nothing. */
  const itemStatus = (item: NavItem): { color: string; label: string; text: string } | null => {
    if (item.path === '/run' && runningCount > 0) {
      return {
        color: 'blue',
        label: String(runningCount),
        text: `${runningCount} ${t('app.running')}`,
      };
    }
    if (item.path === '/' && envUnhealthy) {
      return { color: 'red', label: '!', text: t('app.envNeedsAttention') };
    }
    return null;
  };

  const renderItem = (item: NavItem) => {
    const status = itemStatus(item);
    const active = currentPath === item.path;

    if (rail) {
      const link = (
        <NavLink
          aria-label={status ? `${t(item.labelKey)} (${status.text})` : t(item.labelKey)}
          label={<Center>{item.icon}</Center>}
          active={active}
          onClick={() => navigateTo(item.path)}
          variant="filled"
          px={0}
        />
      );
      return (
        <Tooltip
          key={item.path}
          label={t(item.labelKey)}
          position="right"
          withArrow
          openDelay={200}
        >
          {status ? (
            // A 64px rail has no room for a rightSection, so the badge floats on
            // the icon. The offset points inward: a badge outside the item box
            // would be clipped by the navbar's ScrollArea.
            <Indicator color={status.color} label={status.label} size={16} offset={8} withBorder>
              {link}
            </Indicator>
          ) : (
            link
          )}
        </Tooltip>
      );
    }

    return (
      <Tooltip
        key={item.path}
        label={t(item.descKey)}
        position="right"
        withArrow
        openDelay={400}
        multiline
        w={240}
      >
        <NavLink
          label={t(item.labelKey)}
          leftSection={item.icon}
          active={active}
          onClick={() => navigateTo(item.path)}
          variant="filled"
          rightSection={
            status ? (
              <Tooltip label={status.text} withArrow>
                <Badge size="xs" color={status.color} circle>
                  {status.label}
                </Badge>
              </Tooltip>
            ) : null
          }
        />
      </Tooltip>
    );
  };

  /** Items of a basic category that are visible in the CURRENT mode. */
  const visibleItems = (cat: NavCategory) =>
    cat.items.filter((item) => !item.advanced || advancedMode);

  const renderCategory = (cat: NavCategory, index: number) => (
    <div key={cat.labelKey}>
      {rail ? (
        // The category name has nowhere to go at 64px; a rule keeps the grouping
        // it encoded.
        index > 0 && <Divider mx="xs" my="xs" />
      ) : (
        <Text size="xs" fw={700} c="dimmed" tt="uppercase" px="sm" pt="md" pb={4}>
          {t(cat.labelKey)}
        </Text>
      )}
      {visibleItems(cat).map(renderItem)}
    </div>
  );

  return (
    <>
      <SpotlightSearch
        onNavigate={handleSpotlightNavigate}
        onLoadBookmark={handleSpotlightBookmark}
      />
      <KeyboardShortcuts />
      {/* Asks for a display name on first open — test-case edits are stamped
          with it, so there is no useful state without one. */}
      <UserNameGate />

      <AppShell
        header={{ height: 56 }}
        navbar={{
          width: rail ? RAIL_WIDTH : NAVBAR_WIDTH,
          breakpoint: 'sm',
          collapsed: { mobile: !opened },
        }}
        padding="md"
      >
        <AppShell.Header>
          <Group h="100%" px="md" justify="space-between">
            <Group gap="sm">
              <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
              {/* The desktop twin of the Burger, in the same corner: the control
                  that resizes the navbar sits above the navbar's own column, on
                  the header's existing row, so it costs no extra row anywhere. */}
              <Tooltip
                label={
                  <Group gap={6} wrap="nowrap">
                    <Text size="xs">{rail ? t('nav.expandRail') : t('nav.collapseRail')}</Text>
                    <Kbd size="xs">⌘B</Kbd>
                  </Group>
                }
                withArrow
              >
                <ActionIcon
                  visibleFrom="sm"
                  size="md"
                  variant="subtle"
                  color="gray"
                  aria-label={rail ? t('nav.expandRail') : t('nav.collapseRail')}
                  onClick={() => setNavRailCollapsed(!navRailCollapsed)}
                >
                  {rail ? (
                    <TbLayoutSidebarLeftExpand size={18} />
                  ) : (
                    <TbLayoutSidebarLeftCollapse size={18} />
                  )}
                </ActionIcon>
              </Tooltip>
              <img src="/logo.png" alt="Hub" style={{ height: 32, width: 'auto' }} />
              <Title order={4}>AutoQA Hub</Title>
              {runningCount > 0 && (
                <Tooltip label={t('app.peekRunning')}>
                  <Badge
                    color="blue"
                    variant="dot"
                    size="lg"
                    style={{ cursor: 'pointer' }}
                    onClick={() => setFloatingOpen((v) => !v)}
                  >
                    {runningCount} {t('app.running')}
                  </Badge>
                </Tooltip>
              )}
            </Group>
            <Group gap="xs">
              <Tooltip label={t('app.searchHint')}>
                <Badge
                  variant="default"
                  size="lg"
                  style={{ cursor: 'pointer' }}
                  onClick={() => spotlight.open()}
                >
                  <Group gap={4}>
                    <Text size="xs" c="dimmed">
                      {t('common.search')}
                    </Text>
                    <Kbd size="xs">⌘K</Kbd>
                  </Group>
                </Badge>
              </Tooltip>
              <Tooltip
                label={advancedMode ? t('common.advancedModeOn') : t('common.advancedModeOff')}
                withArrow
                multiline
                w={260}
              >
                <Switch
                  size="sm"
                  labelPosition="left"
                  // The text label is dropped below md so the header cannot
                  // crowd on a laptop width; the tooltip + aria-label carry the
                  // meaning when only the switch is visible.
                  label={
                    <Text size="xs" visibleFrom="md">
                      {t('common.advancedMode')}
                    </Text>
                  }
                  aria-label={t('common.advancedMode')}
                  checked={advancedMode}
                  onChange={(e) => {
                    setAdvancedMode(e.currentTarget.checked);
                    setAdvancedNavOpen(null);
                  }}
                />
              </Tooltip>
              <LanguageToggle />
              <NotificationCenter />
            </Group>
          </Group>
        </AppShell.Header>

        <AppShell.Navbar p="xs">
          <AppShell.Section grow component={ScrollArea}>
            {NAV_CATEGORIES.filter((cat) => !cat.advanced).map(renderCategory)}
            {/* An "Advanced" expander cannot say what it holds at 64px, so the
                rail drops it and follows the advanced-mode preference directly:
                the gated items are either all there or reachable via ⌘K and the
                header switch. */}
            {rail
              ? advancedMode && (
                  <>
                    <Divider mx="xs" my="xs" />
                    {NAV_CATEGORIES.filter((cat) => cat.advanced)
                      .flatMap((cat) => cat.items)
                      .map(renderItem)}
                  </>
                )
              : // Basic mode hides the expander itself, not just its contents: a row
                // labelled "Advanced" that only ever reveals operator surfaces is
                // noise for someone who has opted out of them. The header switch and
                // ⌘K still reach everything.
                advancedMode && (
                  <>
                    <NavLink
                      mt="xs"
                      label={t('nav.advanced')}
                      leftSection={<TbAdjustmentsHorizontal size={18} />}
                      rightSection={
                        showAdvanced ? <TbChevronDown size={14} /> : <TbChevronRight size={14} />
                      }
                      onClick={() => setAdvancedNavOpen(!showAdvanced)}
                      variant="subtle"
                      c={showAdvanced ? undefined : 'dimmed'}
                    />
                    {/* Nest the advanced categories under the toggle with an indented
                    left rail so items like Docker Services read as "inside
                    Advanced" rather than as their own top-level section. */}
                    {showAdvanced && (
                      <div
                        style={{
                          marginLeft: 12,
                          paddingLeft: 8,
                          borderLeft: '2px solid var(--mantine-color-default-border)',
                        }}
                      >
                        {NAV_CATEGORIES.filter((cat) => cat.advanced).map(renderCategory)}
                      </div>
                    )}
                  </>
                )}
          </AppShell.Section>
          <AppShell.Section>{renderItem(SETTINGS_ITEM)}</AppShell.Section>
        </AppShell.Navbar>

        {/* Pin the shell to the viewport height (dvh, not a fixed px) and clip
            it, so the app frame never triggers the browser's own scrollbar. The
            content region below becomes the scroll container instead — pages
            that fill 100% height scroll internally (tables, terminal), and
            taller pages scroll within the content area while the header/navbar
            stay put. */}
        <AppShell.Main
          style={{ height: '100dvh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
        >
          {/* Centered, width-capped content column. Keeps line lengths readable
          on ultrawide monitors instead of stretching forms/tables edge-to-edge,
          while preserving the full-height flex chain that pages like Run rely on.
          Tune CONTENT_MAX_WIDTH in one place to widen/narrow every page. */}
          <div
            style={{
              width: '100%',
              maxWidth: CONTENT_MAX_WIDTH,
              marginInline: 'auto',
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {runningCount > 0 && currentPath !== '/run' && (
              <div style={{ marginBottom: 12, flexShrink: 0 }}>
                <ActiveRunsBanner runs={activeRuns.data ?? []} />
              </div>
            )}
            {/* Default scroll container: full-height pages fill this exactly
                (no scroll here, they scroll inside), while ordinary tall pages
                scroll here rather than the window. */}
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <ErrorBoundary>
                <Suspense fallback={<PageLoader />}>
                  <Outlet />
                </Suspense>
              </ErrorBoundary>
            </div>
          </div>
        </AppShell.Main>
      </AppShell>

      <FloatingRunsWindow
        runs={activeRuns.data ?? []}
        visible={floatingOpen && currentPath !== '/run'}
        onClose={() => setFloatingOpen(false)}
        onJumpToRuns={() => {
          setFloatingOpen(false);
          navigateTo('/run');
        }}
      />
    </>
  );
}
