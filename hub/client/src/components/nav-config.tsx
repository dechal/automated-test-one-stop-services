import {
  TbBrandDocker,
  TbCalendarTime,
  TbChartBar,
  TbChartLine,
  TbChecklist,
  TbFolderFilled,
  TbHistory,
  TbKey,
  TbPhoto,
  TbPlayerPlay,
  TbReportAnalytics,
  TbSettings,
  TbWebhook,
} from 'react-icons/tb';
import type { TranslationKey } from '~/i18n/en';

// ---------------------------------------------------------------------------
// Nav structure
// ---------------------------------------------------------------------------

export type PagePath =
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

export interface NavItem {
  path: PagePath;
  labelKey: TranslationKey;
  descKey: TranslationKey;
  icon: React.ReactNode;
}

export const NAV_ITEMS: NavItem[] = [
  {
    path: '/',
    labelKey: 'nav.dashboard',
    descKey: 'nav.dashboard.desc',
    icon: <TbChartBar size={18} />,
  },
  {
    path: '/schedules',
    labelKey: 'nav.schedules',
    descKey: 'nav.schedules.desc',
    icon: <TbCalendarTime size={18} />,
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
    labelKey: 'nav.results',
    descKey: 'nav.history.desc',
    icon: <TbHistory size={18} />,
  },
  {
    path: '/testcases',
    labelKey: 'nav.testCases',
    descKey: 'nav.testCases.desc',
    icon: <TbChecklist size={18} />,
  },
  {
    path: '/insights',
    labelKey: 'nav.analyze',
    descKey: 'nav.analyze.desc',
    icon: <TbChartLine size={18} />,
  },
  {
    path: '/artifacts',
    labelKey: 'nav.artifacts',
    descKey: 'nav.artifacts.desc',
    icon: <TbPhoto size={18} />,
  },
  {
    path: '/projects',
    labelKey: 'nav.projects',
    descKey: 'nav.projects.desc',
    icon: <TbFolderFilled size={18} />,
  },
];

/** Pinned below the categories: reached from every page, never scrolled away. */
export const SETTINGS_ITEM: NavItem = {
  path: '/settings',
  labelKey: 'nav.settings',
  descKey: 'nav.settings.desc',
  icon: <TbSettings size={18} />,
};

export const SEARCH_ONLY_ITEMS: NavItem[] = [
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
  {
    path: '/webhooks',
    labelKey: 'nav.webhooks',
    descKey: 'nav.webhooks.desc',
    icon: <TbWebhook size={18} />,
  },
];
