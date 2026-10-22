import type { Bookmark, ProjectSummary } from '@hub/shared';
import { Spotlight, type SpotlightActionData } from '@mantine/spotlight';
import { useQuery } from '@tanstack/react-query';
import { TbBookmark, TbFolderFilled } from 'react-icons/tb';
import { api } from '~/api/client.js';
import {
  NAV_CATEGORIES,
  type PagePath,
  SEARCH_ONLY_ITEMS,
  SETTINGS_ITEM,
} from '~/components/nav-config.js';
import { en } from '~/i18n/en';
import { useT } from '~/i18n/index.js';

interface SpotlightSearchProps {
  onNavigate: (path: PagePath) => void;
  onLoadBookmark: (config: Bookmark['config']) => void;
}

export function SpotlightSearch({ onNavigate, onLoadBookmark }: SpotlightSearchProps) {
  const t = useT();

  const projects = useQuery<ProjectSummary[]>({
    queryKey: ['projects'],
    queryFn: () => api.get('/api/projects'),
  });

  const bookmarks = useQuery<Bookmark[]>({
    queryKey: ['bookmarks'],
    queryFn: () => api.get('/api/bookmarks'),
  });

  const navActions: SpotlightActionData[] = [
    ...NAV_CATEGORIES.flatMap((c) => c.items),
    SETTINGS_ITEM,
    ...SEARCH_ONLY_ITEMS,
  ].map((item) => ({
    id: `nav-${item.path}`,
    label: t(item.labelKey),
    description: t(item.descKey),
    leftSection: item.icon,
    onClick: () => onNavigate(item.path),
    keywords: [en[item.labelKey], en[item.descKey]],
    group: t('spotlight.pagesGroup'),
  }));

  const projectActions: SpotlightActionData[] = (projects.data ?? []).map((p) => ({
    id: `project-${p.tool}-${p.type}-${p.name}`,
    label: p.name,
    description: `${p.tool} / ${p.type}`,
    leftSection: <TbFolderFilled size={16} />,
    onClick: () => onNavigate('/projects'),
    keywords: [p.tool, p.type, p.name],
    group: t('nav.projects'),
  }));

  // Newest bookmark first, so an empty query surfaces what was just saved. Mantine's
  // default filter matches label, description and keywords, which together cover
  // name, tool, type, project, mode and tag.
  const bookmarkActions: SpotlightActionData[] = [...(bookmarks.data ?? [])]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((bm) => {
      const c = bm.config;
      const detail = [c.tool, c.type, c.project, c.mode, c.tag].filter(Boolean).join(' · ');
      return {
        id: `bookmark-${bm.id}`,
        label: bm.name,
        description: detail,
        leftSection: <TbBookmark size={16} />,
        onClick: () => {
          onNavigate('/run');
          onLoadBookmark(bm.config);
        },
        keywords: [c.tool, c.type, c.project, c.tag, bm.name].filter((v): v is string => !!v),
        group: t('bookmark.title'),
      };
    });

  const actions = [...navActions, ...projectActions, ...bookmarkActions];

  return (
    <Spotlight
      actions={actions}
      nothingFound={t('spotlight.nothingFound')}
      highlightQuery
      searchProps={{
        placeholder: t('spotlight.placeholder'),
      }}
      shortcut="mod+K"
      scrollable
    />
  );
}
