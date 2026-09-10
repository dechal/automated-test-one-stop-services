import { Tabs } from '@mantine/core';
import { lazy, Suspense, useState } from 'react';
import { TbChartLine, TbFlame, TbListCheck } from 'react-icons/tb';
import { ListSkeleton, StatCardsSkeleton } from '~/components/Skeletons.js';
import { useTools } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';

const CoveragePage = lazy(() => import('./Coverage.js').then((m) => ({ default: m.CoveragePage })));

// Code-split each tab into its own chunk. Flaky and Performance were previously
// imported eagerly, so opening Insights pulled both pages (and their charts) in
// one chunk. lazy() defers each until its tab is first opened.
const FlakyTestsPage = lazy(() =>
  import('./FlakyTests.js').then((m) => ({ default: m.FlakyTestsPage })),
);
const PerformancePage = lazy(() =>
  import('./Performance.js').then((m) => ({ default: m.PerformancePage })),
);

type InsightsTab = 'flaky' | 'coverage' | 'performance';

export function InsightsPage() {
  const t = useT();
  // Performance is k6-only. Hide its tab when k6 is not installed rather than
  // showing a tab that only ever renders a "k6 not installed" empty state.
  const k6Installed = (useTools().data ?? []).some(
    (tv) => tv.id === 'k6' && tv.status === 'enabled',
  );
  const [tab, setTab] = useState<InsightsTab>('flaky');
  // Track which tabs have been opened: each page's chunk loads on first visit,
  // then stays mounted so its local filter state survives tab switches and
  // React Query serves cached data (no refetch flash on switch back).
  const [opened, setOpened] = useState<Set<InsightsTab>>(() => new Set<InsightsTab>(['flaky']));

  const selectTab = (value: string | null) => {
    const next = (value as InsightsTab) ?? 'flaky';
    setTab(next);
    setOpened((prev) => {
      if (prev.has(next)) return prev;
      const updated = new Set(prev);
      updated.add(next);
      return updated;
    });
  };

  // If k6 was uninstalled while the Performance tab was active, fall back so the
  // page never sits on a tab that no longer exists.
  const activeTab = tab === 'performance' && !k6Installed ? 'flaky' : tab;

  return (
    <Tabs value={activeTab} onChange={selectTab}>
      <Tabs.List mb="md">
        <Tabs.Tab value="flaky" leftSection={<TbFlame size={16} />}>
          {t('nav.flakyTests')}
        </Tabs.Tab>
        <Tabs.Tab value="coverage" leftSection={<TbListCheck size={16} />}>
          {t('nav.coverage')}
        </Tabs.Tab>
        {k6Installed && (
          <Tabs.Tab value="performance" leftSection={<TbChartLine size={16} />}>
            {t('nav.performance')}
          </Tabs.Tab>
        )}
      </Tabs.List>

      <Tabs.Panel value="flaky">
        {opened.has('flaky') && (
          <Suspense fallback={<ListSkeleton />}>
            <FlakyTestsPage />
          </Suspense>
        )}
      </Tabs.Panel>
      <Tabs.Panel value="coverage">
        {opened.has('coverage') && (
          <Suspense fallback={<ListSkeleton />}>
            <CoveragePage />
          </Suspense>
        )}
      </Tabs.Panel>
      {k6Installed && (
        <Tabs.Panel value="performance">
          {opened.has('performance') && (
            <Suspense fallback={<StatCardsSkeleton />}>
              <PerformancePage />
            </Suspense>
          )}
        </Tabs.Panel>
      )}
    </Tabs>
  );
}
