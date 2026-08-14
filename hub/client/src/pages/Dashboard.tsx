import {
  Badge,
  Button,
  CloseButton,
  Group,
  Loader,
  Paper,
  ScrollArea,
  SimpleGrid,
  Skeleton,
  Stack,
  Stepper,
  Text,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { lazy, Suspense, useCallback, useMemo } from 'react';
import { TbPlayerPlay, TbRocket } from 'react-icons/tb';
import { qDoctor, qProjects, qRunsHistory } from '~/api/queries.js';
import { DoctorPanel } from '~/components/DoctorPanel.js';
import { NeedsAttentionWidget } from '~/components/NeedsAttentionWidget.js';
import { PageHeader } from '~/components/PageHeader.js';

import { useTools } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';
import { usePreferences } from '~/stores/hub.js';
import { useNavigationStore } from '~/stores/navigation.js';
import { runOutcome } from '~/utils/run-status.js';
import { toolLabel } from '~/utils/tool-label.js';

/**
 * The three charts pull in the charting library (~470 kB before gzip), which is
 * more code than the rest of the dashboard combined. They live below the fold,
 * so they load on their own instead of delaying the numbers and recent runs at
 * the top of the page. `Skeleton` holds their space while that happens.
 */
const TrendChart = lazy(() =>
  import('~/components/TrendChart.js').then((m) => ({ default: m.TrendChart })),
);
const TopProjectsBars = lazy(() =>
  import('~/components/TopProjectsBars.js').then((m) => ({ default: m.TopProjectsBars })),
);
const RunHeatmap = lazy(() =>
  import('~/components/RunHeatmap.js').then((m) => ({ default: m.RunHeatmap })),
);

export function DashboardPage() {
  const navigate = useNavigate();
  const t = useT();

  const onNavigate = useCallback(
    (page: string) => {
      const path = page === 'dashboard' ? '/' : `/${page}`;
      navigate({ to: path });
    },
    [navigate],
  );

  const prefs = usePreferences();
  const setPendingRunConfig = useNavigationStore((s) => s.setPendingRunConfig);

  const doctor = useQuery(qDoctor());
  const toolsQuery = useTools();
  const projects = useQuery(qProjects());

  // Only surface enabled tools in the overview — disabled/uninstalled/broken
  // tools must not appear on the dashboard (status comes from the manifest
  // registry; `broken` and `disabled` are both excluded).
  const enabledTools = useMemo(
    () => (toolsQuery.data ?? []).filter((tool) => tool.status === 'enabled'),
    [toolsQuery.data],
  );

  const history = useQuery(qRunsHistory());

  const recentRuns = useMemo(
    () =>
      (history.data ?? [])
        .filter((r) => r.endedAt)
        .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))
        .slice(0, 8),
    [history.data],
  );

  // One-click re-run: load a past run's settings onto the Run page (does not
  // auto-execute — the user confirms with the Run button). Mirrors History.
  const rerun = useCallback(
    (config: Parameters<typeof setPendingRunConfig>[0]) => {
      setPendingRunConfig(config);
      navigate({ to: '/run' });
    },
    [navigate, setPendingRunConfig],
  );

  const hasProjects = (projects.data ?? []).length > 0;
  const envOk = doctor.data?.overallOk ?? false;
  const hasRuns = (history.data ?? []).length > 0;
  // The getting-started card retires itself once all three steps are genuinely
  // done, so nobody has to know that the × in the corner is what hides it. The
  // Settings switch still brings it back on demand.
  const onboardingDone = envOk && hasProjects && hasRuns;

  return (
    <Stack gap="md">
      <PageHeader
        title={t('dashboard.title')}
        description={t('nav.dashboard.desc')}
        actions={
          hasProjects ? (
            <Button
              color="green"
              leftSection={<TbPlayerPlay size={16} />}
              onClick={() => onNavigate('run')}
            >
              {t('nav.runTests')}
            </Button>
          ) : null
        }
      />

      {/* Loading skeleton — shown during initial data fetch */}
      {(toolsQuery.isLoading || projects.isLoading || history.isLoading) &&
        !projects.data &&
        !history.data && (
          <Stack gap="md">
            <Skeleton height={80} radius="md" />
            <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md">
              <Skeleton height={340} radius="md" />
              <Skeleton height={340} radius="md" />
              <Skeleton height={340} radius="md" />
            </SimpleGrid>
            <Skeleton height={200} radius="md" />
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
              <Skeleton height={200} radius="md" />
              <Skeleton height={200} radius="md" />
            </SimpleGrid>
          </Stack>
        )}

      {/* Main content — render once data is available */}
      {(projects.data || history.data || (!toolsQuery.isLoading && !projects.isLoading)) && (
        <>
          {/* Onboarding */}
          {prefs.showOnboarding && !onboardingDone && (
            <Paper p="md" withBorder style={{ position: 'relative' }}>
              <CloseButton
                size="sm"
                style={{ position: 'absolute', top: 8, right: 8 }}
                onClick={prefs.dismissOnboarding}
                aria-label={t('dashboard.dismissOnboarding')}
              />
              <Group gap="sm" mb="sm">
                <TbRocket size={20} color="var(--mantine-color-brand-6)" />
                <Title order={5}>{t('dashboard.gettingStarted')}</Title>
              </Group>
              <Stepper
                active={envOk ? (hasProjects ? (hasRuns ? 3 : 2) : 1) : 0}
                size="sm"
                orientation="horizontal"
              >
                <Stepper.Step
                  label={t('dashboard.stepEnv')}
                  description={envOk ? t('dashboard.stepEnvOk') : t('dashboard.stepEnvFix')}
                />
                <Stepper.Step
                  label={t('dashboard.stepProjects')}
                  description={
                    hasProjects
                      ? `${projects.data?.length} ${t('dashboard.stepProjectsReady')}`
                      : t('dashboard.stepProjectsCreate')
                  }
                />
                <Stepper.Step
                  label={t('dashboard.stepRun')}
                  description={t('dashboard.stepRunDesc')}
                />
              </Stepper>
              <Group gap="xs" mt="md">
                {!hasProjects && (
                  <Button size="xs" onClick={() => onNavigate('projects')}>
                    {t('run.goToProjects')}
                  </Button>
                )}
                {hasProjects && (
                  <Button size="xs" onClick={() => onNavigate('run')}>
                    {t('nav.runTests')}
                  </Button>
                )}
              </Group>
            </Paper>
          )}

          {/* Doctor status — collapse to a single OK badge once everything is green
          to keep the dashboard clean for users with a healthy environment. */}
          <DoctorPanel doctor={doctor.data} isLoading={doctor.isLoading} />

          {/* Recent Runs + Project Overview — side by side.
              `alignItems: start` is deliberate: a CSS grid stretches every child
              to the tallest row, so the two short cards were padded out to the
              height of the scrolling run list and sat ~60% empty. Letting each
              card end where its content ends removes that dead space without
              taking anything off the page. */}
          <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md" style={{ alignItems: 'start' }}>
            {/* Recent Runs */}
            <Paper p="md" withBorder>
              <Group justify="space-between" mb="sm">
                <Title order={5}>{t('dashboard.recentRuns')}</Title>
                {recentRuns.length > 0 && (
                  <Button size="compact-xs" variant="subtle" onClick={() => onNavigate('history')}>
                    {t('dashboard.viewAll')}
                  </Button>
                )}
              </Group>

              {history.isLoading && (
                <Group gap="xs">
                  <Loader size="xs" />
                  <Text c="dimmed" size="sm">
                    {t('common.loading')}
                  </Text>
                </Group>
              )}
              {!history.isLoading && recentRuns.length === 0 && (
                <Text size="sm" c="dimmed">
                  {t('dashboard.noRuns')}
                </Text>
              )}
              {recentRuns.length > 0 && (
                <Text size="xs" c="dimmed" mb={6}>
                  {t('dashboard.recentRunHint')}
                </Text>
              )}
              {recentRuns.length > 0 && (
                // Autosize + `mah`, not a fixed `h`: a fixed height padded the
                // card out to 35vh even when the list was shorter, which is where
                // the empty space under these cards came from. The cap still stops
                // a long list from pushing the trend chart off-screen.
                <ScrollArea.Autosize mah="35vh">
                  <Stack gap={6}>
                    {recentRuns.map((run) => (
                      <Tooltip
                        key={run.id}
                        label={t('dashboard.runAgain')}
                        position="left"
                        withArrow
                        openDelay={500}
                      >
                        <UnstyledButton
                          onClick={() => rerun(run.request)}
                          aria-label={`${t('dashboard.runAgain')} · ${run.request.project}`}
                          data-run-row
                          style={{
                            display: 'block',
                            borderRadius: 6,
                            background: 'var(--mantine-color-default-hover)',
                          }}
                        >
                          <Group justify="space-between" px="sm" py={6} wrap="nowrap">
                            <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                              {/* Tinted, not filled: eight solid red pills down a
                                  short list read as one alarming block rather
                                  than eight separate outcomes.
                                  Same `runOutcome` vocabulary as Reports and
                                  History — showing `FAILED` here while those
                                  pages said "tests failed" gave one app two names
                                  for one thing, which is worse than either. */}
                              <Badge size="xs" color={runOutcome(run.status, run.summary).color}>
                                {t(runOutcome(run.status, run.summary).labelKey)}
                              </Badge>
                              <Text size="xs" fw={500} truncate>
                                {run.request.project}
                              </Text>
                              {/* Tool is context; it does not need a chip of its own. */}
                              <Text size="xs" c="dimmed">
                                {toolLabel(run.request.tool, toolsQuery.data ?? [])}
                              </Text>
                            </Group>
                            <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
                              <Text size="xs" c="dimmed">
                                {run.endedAt ? dayjs(run.endedAt).fromNow() : '-'}
                              </Text>
                              <TbPlayerPlay
                                size={14}
                                color="var(--mantine-color-green-6)"
                                aria-hidden
                              />
                            </Group>
                          </Group>
                        </UnstyledButton>
                      </Tooltip>
                    ))}
                  </Stack>
                </ScrollArea.Autosize>
              )}
            </Paper>
            {/* Project overview */}
            <Paper p="md" withBorder>
              <Group justify="space-between" mb="sm">
                <Title order={5}>{t('dashboard.projectsOverview')}</Title>
                <Button size="compact-xs" variant="subtle" onClick={() => onNavigate('projects')}>
                  {t('dashboard.manage')}
                </Button>
              </Group>
              {projects.isLoading && (
                <Group gap="xs">
                  <Loader size="xs" />
                  <Text c="dimmed" size="sm">
                    {t('common.loading')}
                  </Text>
                </Group>
              )}
              {projects.data && (
                // One number per tool used to get a tall centred card each, so
                // three values filled the whole column and still read as three
                // separate widgets. As rows they scan top-to-bottom in one pass
                // and sit at the same density as the run list beside them.
                <ScrollArea.Autosize mah="35vh">
                  <Stack gap={2}>
                    {enabledTools.map((tool) => (
                      <Group
                        key={tool.id}
                        justify="space-between"
                        wrap="nowrap"
                        px="xs"
                        py={6}
                        style={{
                          borderRadius: 6,
                          background: 'var(--mantine-color-default-hover)',
                        }}
                      >
                        <Text size="xs" truncate>
                          {tool.title}
                        </Text>
                        <Text size="sm" fw={700} style={{ flexShrink: 0 }}>
                          {projects.data?.filter((p) => p.tool === tool.id).length ?? 0}
                        </Text>
                      </Group>
                    ))}
                  </Stack>
                </ScrollArea.Autosize>
              )}
            </Paper>
            {/* Needs Attention */}
            <NeedsAttentionWidget onNavigate={onNavigate} />
          </SimpleGrid>

          {/* Test Trend Chart */}
          <Paper p="md" withBorder>
            <Group justify="space-between" mb="sm">
              <Title order={5}>{t('dashboard.testTrends')}</Title>
              <Text size="xs" c="dimmed">
                {t('dashboard.trendsDesc')}
              </Text>
            </Group>
            <Suspense fallback={<Skeleton height={220} radius="sm" aria-hidden />}>
              <TrendChart />
            </Suspense>
          </Paper>

          {/* Top Projects + Run Activity — side by side */}
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
            {/* Top Projects */}
            <Paper p="md" withBorder>
              <Group justify="space-between" mb="sm">
                <Title order={5}>{t('dashboard.topProjects')}</Title>
                <Text size="xs" c="dimmed">
                  {t('dashboard.topProjectsDesc')}
                </Text>
              </Group>
              <Suspense fallback={<Skeleton height={160} radius="sm" aria-hidden />}>
                <TopProjectsBars />
              </Suspense>
            </Paper>

            {/* Run Activity Heatmap */}
            <Paper p="md" withBorder>
              <Group justify="space-between" mb="sm">
                <Title order={5}>{t('dashboard.runActivity')}</Title>
                <Text size="xs" c="dimmed">
                  {t('dashboard.runActivityDesc')}
                </Text>
              </Group>
              <Suspense fallback={<Skeleton height={160} radius="sm" aria-hidden />}>
                <RunHeatmap />
              </Suspense>
            </Paper>
          </SimpleGrid>
        </>
      )}
    </Stack>
  );
}
