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
  /**
   * Advanced-only ITEM inside an otherwise basic category. Hidden from the navbar
   * in simple mode, and it keeps its category (moving it into an `advanced`
   * category would file it under the wrong heading). ⌘K still reaches it, exactly
   * like the items in `advanced` categories.
   */
  advanced?: boolean;
}

export interface NavCategory {
  labelKey: TranslationKey;
  /** When true the whole category is tucked behind the "Advanced" toggle. */
  advanced?: boolean;
  items: NavItem[];
}

export const NAV_CATEGORIES: NavCategory[] = [
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
export const SETTINGS_ITEM: NavItem = {
  path: '/settings',
  labelKey: 'nav.settings',
  descKey: 'nav.settings.desc',
  icon: <TbSettings size={18} />,
};

export const SEARCH_ONLY_ITEMS: NavItem[] = [
  {
    path: '/webhooks',
    labelKey: 'nav.webhooks',
    descKey: 'nav.webhooks.desc',
    icon: <TbWebhook size={18} />,
  },
];
