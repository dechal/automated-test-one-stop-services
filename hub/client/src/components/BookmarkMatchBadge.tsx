import { findDuplicateBookmark, type RunRequest } from '@hub/shared';
import { Badge, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { TbBookmark, TbBookmarkOff } from 'react-icons/tb';
import { qBookmarkList } from '~/api/queries.js';
import { StatTooltip } from '~/components/StatTooltip.js';
import { useT } from '~/i18n/index.js';

const BADGE_MAX_WIDTH = 360;

/**
 * Tells the user whether the form, as it stands, is identical to a saved
 * bookmark (same comparison the save-bookmark duplicate check uses), and which
 * one. Renders nothing until a project is chosen and at least one bookmark exists.
 */
export function BookmarkMatchBadge({ config }: { config: RunRequest }) {
  const t = useT();
  const list = useQuery(qBookmarkList()).data;
  if (!config.project || !list || list.length === 0) return null;
  const match = findDuplicateBookmark(list, config);
  if (!match) {
    return (
      <Badge
        variant="outline"
        color="gray"
        size="sm"
        leftSection={<TbBookmarkOff size={12} />}
        style={{ textTransform: 'none' }}
      >
        {t('bookmark.noMatchSaved')}
      </Badge>
    );
  }
  return (
    <Tooltip label={<StatTooltip title={t('bookmark.matches')} detail={match.name} />}>
      <Badge
        variant="light"
        color="green"
        size="sm"
        leftSection={<TbBookmark size={12} />}
        maw={BADGE_MAX_WIDTH}
        style={{ textTransform: 'none' }}
      >
        {t('bookmark.matches')}: {match.name}
      </Badge>
    </Tooltip>
  );
}
