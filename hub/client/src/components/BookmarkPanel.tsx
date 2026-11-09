import type { Bookmark, BookmarkWithStatus, RunRequest } from '@hub/shared';
import {
  ActionIcon,
  Badge,
  Button,
  Collapse,
  Group,
  Loader,
  Menu,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  TbAlertTriangle,
  TbBookmark,
  TbCheck,
  TbChevronRight,
  TbCloudOff,
  TbDeviceFloppy,
  TbDots,
  TbEraser,
  TbPencil,
  TbPlayerPlay,
  TbSearch,
  TbTrash,
  TbX,
} from 'react-icons/tb';
import { api } from '~/api/client.js';
import { qBookmarks, queryRoots } from '~/api/queries.js';
import { confirmDialog } from '~/components/confirmDialog.js';
import { EmptyState } from '~/components/EmptyState.js';
import { toast } from '~/components/Toast.js';
import { useCollapsedGroups } from '~/hooks/useCollapsedGroups.js';
import { useTools } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';
import { parseTagQuery } from '~/utils/tag-selection.js';
import { toolLabel } from '~/utils/tool-label.js';

export interface SaveBookmarkPayload {
  name: string;
  config: RunRequest;
}

/**
 * The one write path for "save this run-form config as a new bookmark". It lives
 * next to the list it invalidates and is called from the Run footer's save
 * action, the only place that creates a bookmark. Callers add their own per-call
 * `onSuccess` for local UI (closing the modal, clearing a field).
 */
export function useSaveBookmark() {
  const t = useT();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: SaveBookmarkPayload) => api.post<Bookmark>('/api/bookmarks', payload),
    onSuccess: () => {
      toast.success(t('bookmark.saved'));
      queryClient.invalidateQueries({ queryKey: [queryRoots.bookmarks] });
    },
  });
}

const MODAL_WIDTH = 800;
const NAME_COL = 200;
const META_COL = 150;
const ROW_HEIGHT = 40;

/** Run options that vary within a group, shown in the meta column. */
function runMeta(c: RunRequest): string {
  const parts: string[] = [c.mode];
  if (c.headless) parts.push(c.headless);
  if (c.silent) parts.push('silent');
  if (c.discardReport) parts.push('no report');
  if (c.noTrack) parts.push('no-track');
  return parts.filter(Boolean).join(' · ');
}

function bare(tag: string): string {
  return tag.replace(/^@/, '');
}

/** Newest first. `createdAt` is an ISO timestamp, so a lexical compare is chronological. */
function byNewest(a: Bookmark, b: Bookmark): number {
  return b.createdAt.localeCompare(a.createdAt);
}

/** `query` must already be trimmed + lowercased; an empty query matches everything. */
function matchesQuery(bm: Bookmark, query: string): boolean {
  if (!query) return true;
  const c = bm.config;
  return (
    bm.name.toLowerCase().includes(query) ||
    c.project.toLowerCase().includes(query) ||
    c.type.toLowerCase().includes(query) ||
    c.tool.toLowerCase().includes(query) ||
    (c.tag?.toLowerCase().includes(query) ?? false)
  );
}

interface TreeGroup {
  key: string;
  tool: string;
  type: string;
  project: string;
  items: BookmarkWithStatus[];
}

/** tool → type · project groups, sorted by label then type then project. */
function groupBookmarks(
  list: BookmarkWithStatus[],
  query: string,
  tools: ReturnType<typeof useTools>['data'],
  currentKey: string,
): {
  groups: TreeGroup[];
} {
  const matched = list.filter((bm) => matchesQuery(bm, query));
  const map = new Map<string, TreeGroup>();
  for (const bm of matched) {
    const { tool, type, project } = bm.config;
    const key = `${tool}|${type}|${project}`;
    const g = map.get(key);
    if (g) g.items.push(bm);
    else map.set(key, { key, tool, type, project, items: [bm] });
  }
  for (const g of map.values()) g.items.sort(byNewest);
  const list2 = tools ?? [];
  const groups = [...map.values()].sort(
    (a, b) =>
      Number(b.key === currentKey) - Number(a.key === currentKey) ||
      toolLabel(a.tool, list2).localeCompare(toolLabel(b.tool, list2)) ||
      a.type.localeCompare(b.type) ||
      a.project.localeCompare(b.project),
  );
  return { groups };
}

interface BookmarkLoadModalProps {
  /** Pulls the LIVE run-form config of the active session — used to pre-focus the
   *  group matching the current run target. */
  getConfig: () => RunRequest;
  onLoad: (config: RunRequest) => void;
}

/**
 * "Load a bookmark" as a full modal (not a dropdown). One search field at the top
 * (auto-focused), then every saved config as a `tool → type · project` group.
 * Groups are expanded by default so the whole map is visible with zero clicks;
 * collapse the ones you don't need. Typing filters live and re-expands matches.
 * Click any bookmark chip to load it and close — a single click end to end.
 * Rename/delete happen inline inside the modal.
 */
export function BookmarkLoadModal({ getConfig, onLoad }: BookmarkLoadModalProps) {
  const t = useT();
  const tools = useTools().data ?? [];
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState(false);
  const [q, setQ] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [currentKey, setCurrentKey] = useState('');

  const bookmarks = useQuery({
    ...qBookmarks(),
    enabled: opened,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/bookmarks/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [queryRoots.bookmarks] }),
  });

  const migrateMutation = useMutation({
    mutationFn: (id: string) => api.post<BookmarkWithStatus>(`/api/bookmarks/${id}/migrate`),
    onSuccess: () => {
      toast.success(t('bookmark.migrated'));
      queryClient.invalidateQueries({ queryKey: [queryRoots.bookmarks] });
    },
    onError: () => toast.error(t('bookmark.scanUnavailable')),
  });

  const list = bookmarks.data ?? [];

  const { groups } = useMemo(
    () => groupBookmarks(list, q.trim().toLowerCase(), tools, currentKey),
    [list, q, tools, currentKey],
  );

  // A live search re-expands everything: a collapsed group whose child matched
  // must not stay hidden. Clear the manual collapse set whenever the query is
  // non-empty so every match is visible without a click.
  const searching = q.trim().length > 0;
  const { isCollapsed, isMarked, toggle: toggleGroup, setAll } = useCollapsedGroups({ searching });

  function openModal() {
    setQ('');
    setAll([]);
    setEditingId(null);
    const live = getConfig();
    setCurrentKey(live.project ? `${live.tool}|${live.type}|${live.project}` : '');
    setOpened(true);
  }

  function load(config: RunRequest) {
    onLoad(config);
    setOpened(false);
  }

  const replaceMutation = useMutation({
    mutationFn: (body: { id: string; name: string; config: RunRequest }) =>
      api.put(`/api/bookmarks/${body.id}`, { name: body.name, config: body.config }),
    onSuccess: () => {
      toast.success(t('bookmark.updated'));
      queryClient.invalidateQueries({ queryKey: [queryRoots.bookmarks] });
    },
  });

  async function handleReplace(bm: Bookmark) {
    const live = getConfig();
    if (!live.project) {
      toast.error(t('bookmark.noFormConfig'));
      return;
    }
    const ok = await confirmDialog({
      title: t('bookmark.replaceConfirmTitle'),
      message: t('bookmark.replaceConfirm'),
      confirmLabel: t('common.save'),
    });
    if (ok) replaceMutation.mutate({ id: bm.id, name: bm.name, config: live });
  }

  async function handleDelete(id: string) {
    const ok = await confirmDialog({
      title: t('bookmark.removeTitle'),
      message: t('bookmark.removeConfirm'),
      confirmLabel: t('common.remove'),
      danger: true,
    });
    if (ok) {
      if (editingId === id) setEditingId(null);
      deleteMutation.mutate(id);
    }
  }

  const allCollapsed = groups.length > 0 && groups.every((g) => isMarked(g.key));
  function toggleAll() {
    if (allCollapsed) setAll([]);
    else setAll(groups.map((g) => g.key));
  }

  return (
    <>
      <Button
        size="xs"
        variant="light"
        color="gray"
        leftSection={<TbBookmark size={14} />}
        onClick={openModal}
      >
        {t('bookmark.load')}
      </Button>

      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title={
          <Group gap={12}>
            <TbBookmark size={18} color="var(--mantine-color-dimmed)" />
            <Text fw={500}>{t('bookmark.load')}</Text>
            <Text size="xs" c="dimmed" ff="monospace">
              {t('bookmark.savedCount').replace('{count}', String(list.length))}
            </Text>
          </Group>
        }
        size={MODAL_WIDTH}
        centered
        scrollAreaComponent={ScrollArea.Autosize}
      >
        <Stack gap="sm">
          <Group gap="xs" wrap="nowrap">
            <TextInput
              flex={1}
              value={q}
              onChange={(e) => setQ(e.currentTarget.value)}
              placeholder={t('bookmark.searchPlaceholder')}
              leftSection={<TbSearch size={14} />}
              data-autofocus
            />
            {groups.length > 1 && (
              <Button size="xs" variant="subtle" color="gray" onClick={toggleAll}>
                {allCollapsed ? t('bookmark.expandAll') : t('bookmark.collapseAll')}
              </Button>
            )}
          </Group>

          {bookmarks.isLoading && (
            <Group justify="center" py="lg">
              <Loader size="sm" />
            </Group>
          )}

          {!bookmarks.isLoading && list.length === 0 && (
            <EmptyState
              icon={<TbBookmark size={32} />}
              title={t('bookmark.empty')}
              description={t('bookmark.hint')}
            />
          )}

          {!bookmarks.isLoading && list.length > 0 && groups.length === 0 && (
            <Text size="sm" c="dimmed" ta="center" py="lg">
              {t('bookmark.noMatch')}
            </Text>
          )}

          {groups.length > 0 && (
            <Stack gap="md">
              {groups.map((g) => (
                <div key={g.key}>
                  <UnstyledButton
                    onClick={() => toggleGroup(g.key)}
                    aria-expanded={!isCollapsed(g.key)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      minWidth: 0,
                      padding: '4px 4px 8px',
                    }}
                  >
                    <TbChevronRight
                      size={12}
                      style={{
                        transform: isCollapsed(g.key) ? 'none' : 'rotate(90deg)',
                        transition: 'transform 150ms ease',
                        opacity: 0.6,
                        flexShrink: 0,
                      }}
                    />
                    <Text size="sm" fw={500} truncate>
                      {g.project}
                    </Text>
                    <Text size="xs" c="dimmed" ff="monospace" style={{ flexShrink: 0 }}>
                      {toolLabel(g.tool, tools)} · {g.type}
                    </Text>
                    {g.key === currentKey && (
                      <Badge size="xs" variant="outline" radius="sm" style={{ flexShrink: 0 }}>
                        {t('bookmark.thisProject')}
                      </Badge>
                    )}
                    <Text size="xs" c="dimmed" ff="monospace" ml="auto" style={{ flexShrink: 0 }}>
                      {g.items.length}
                    </Text>
                  </UnstyledButton>
                  <Collapse expanded={!isCollapsed(g.key)}>
                    <Stack gap={2}>
                      {g.items.map((bm) =>
                        editingId === bm.id ? (
                          <InlineEdit
                            key={bm.id}
                            bookmark={bm}
                            getConfig={getConfig}
                            onDone={() => setEditingId(null)}
                          />
                        ) : (
                          <BookmarkRow
                            key={bm.id}
                            bookmark={bm}
                            onApply={() => load(bm.config)}
                            onRename={() => setEditingId(bm.id)}
                            onReplace={() => handleReplace(bm)}
                            onDelete={() => handleDelete(bm.id)}
                            onMigrate={() => migrateMutation.mutate(bm.id)}
                            migrating={
                              (migrateMutation.isPending && migrateMutation.variables === bm.id) ||
                              (replaceMutation.isPending && replaceMutation.variables?.id === bm.id)
                            }
                          />
                        ),
                      )}
                    </Stack>
                  </Collapse>
                </div>
              ))}
            </Stack>
          )}

          {list.length > 0 && (
            <Text size="xs" c="dimmed" ff="monospace">
              {t('bookmark.rowHint')}
            </Text>
          )}
        </Stack>
      </Modal>
    </>
  );
}

/**
 * One saved run config as a compact "chip" card: click the name to autofill,
 * hover reveals rename/delete. Kept as a bordered pill so a group can lay them
 * out side by side and still read cleanly.
 */
function BookmarkRow({
  bookmark,
  onApply,
  onRename,
  onReplace,
  onDelete,
  onMigrate,
  migrating,
}: {
  bookmark: BookmarkWithStatus;
  onApply: () => void;
  onRename: () => void;
  onReplace: () => void;
  onDelete: () => void;
  onMigrate: () => void;
  migrating: boolean;
}) {
  const t = useT();
  const c = bookmark.config;
  const hasStale = bookmark.staleTags.length > 0 && !bookmark.scanFailed;
  const { include, exclude } = parseTagQuery(c.tool, c.tag);
  const scope = [...include.map(bare), c.section, c.performanceType].filter(Boolean).join(', ');
  const meta = runMeta(c);
  return (
    <Group gap={4} wrap="nowrap" className="bm-row">
      <UnstyledButton
        onClick={onApply}
        aria-label={`${t('bookmark.apply')} · ${bookmark.name}`}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'grid',
          gridTemplateColumns: `${NAME_COL}px minmax(0, 1fr) ${META_COL}px`,
          alignItems: 'center',
          gap: 12,
          minHeight: ROW_HEIGHT,
          paddingLeft: 12,
        }}
      >
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <Text size="sm" fw={500} truncate>
            {bookmark.name}
          </Text>
          {hasStale && (
            <Tooltip
              label={`${t('bookmark.staleTooltip')} ${bookmark.staleTags.join(', ')}`}
              withArrow
              multiline
            >
              <Text component="span" c="yellow.5" style={{ display: 'inline-flex', flexShrink: 0 }}>
                <TbAlertTriangle size={14} />
              </Text>
            </Tooltip>
          )}
          {bookmark.scanFailed && (
            <Tooltip label={t('bookmark.scanUnavailable')} withArrow multiline>
              <Text component="span" c="dimmed" style={{ display: 'inline-flex', flexShrink: 0 }}>
                <TbCloudOff size={14} />
              </Text>
            </Tooltip>
          )}
        </Group>
        <Text size="xs" c="dimmed" truncate>
          {scope || (exclude.length === 0 ? t('reports.allTests') : '')}
          {exclude.length > 0 && (
            <>
              {scope ? ' · ' : ''}
              {t('bookmark.not')}{' '}
              <Text span inherit c="red.4" td="line-through">
                {exclude.map(bare).join(', ')}
              </Text>
            </>
          )}
        </Text>
        <Text size="xs" c="dimmed" ff="monospace" truncate>
          {meta}
        </Text>
      </UnstyledButton>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="md"
            loading={migrating}
            aria-label={`${t('bookmark.moreActions')} · ${bookmark.name}`}
          >
            <TbDots size={16} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item leftSection={<TbPlayerPlay size={14} />} onClick={onApply}>
            {t('bookmark.apply')}
          </Menu.Item>
          <Menu.Item leftSection={<TbDeviceFloppy size={14} />} onClick={onReplace}>
            {t('bookmark.syncFromForm')}
          </Menu.Item>
          <Menu.Item leftSection={<TbPencil size={14} />} onClick={onRename}>
            {t('bookmark.rename')}
          </Menu.Item>
          {hasStale && (
            <Menu.Item leftSection={<TbEraser size={14} />} onClick={onMigrate}>
              {t('bookmark.migrate')}
            </Menu.Item>
          )}
          <Menu.Divider />
          <Menu.Item color="red" leftSection={<TbTrash size={14} />} onClick={onDelete}>
            {t('bookmark.delete')}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}

/** Inline rename + optional "grab current form" — no page jump. */
function InlineEdit({
  bookmark,
  getConfig,
  onDone,
}: {
  bookmark: Bookmark;
  getConfig: () => RunRequest;
  onDone: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState(bookmark.name);
  const [pendingConfig, setPendingConfig] = useState<RunRequest | null>(null);

  const updateMutation = useMutation({
    mutationFn: (body: { name: string; config?: RunRequest }) =>
      api.put(`/api/bookmarks/${bookmark.id}`, body),
    onSuccess: () => {
      toast.success(t('bookmark.updated'));
      queryClient.invalidateQueries({ queryKey: [queryRoots.bookmarks] });
      onDone();
    },
  });

  function captureForm() {
    const live = getConfig();
    if (!live.project) {
      toast.error(t('bookmark.noFormConfig'));
      return;
    }
    setPendingConfig(live);
    toast.success(t('bookmark.synced'));
  }

  function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    updateMutation.mutate({ name: trimmed, ...(pendingConfig ? { config: pendingConfig } : {}) });
  }

  return (
    <Paper
      withBorder
      radius="sm"
      px={6}
      py={6}
      h="100%"
      style={{ borderColor: 'var(--mantine-color-brand-filled)' }}
    >
      <Group gap={4} wrap="nowrap" h="100%">
        <TextInput
          size="xs"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave();
            if (e.key === 'Escape') onDone();
          }}
          flex={1}
          data-autofocus
        />
        <Tooltip
          label={pendingConfig ? t('bookmark.synced') : t('bookmark.syncFromForm')}
          withArrow
        >
          <ActionIcon
            variant={pendingConfig ? 'filled' : 'subtle'}
            color={pendingConfig ? 'green' : 'grape'}
            size="sm"
            onClick={captureForm}
            aria-label={t('bookmark.syncFromForm')}
          >
            <TbDeviceFloppy size={13} />
          </ActionIcon>
        </Tooltip>
        <ActionIcon
          variant="filled"
          color="green"
          size="sm"
          onClick={handleSave}
          loading={updateMutation.isPending}
          disabled={!name.trim()}
          aria-label={t('common.save')}
        >
          <TbCheck size={13} />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          onClick={onDone}
          aria-label={t('common.cancel')}
        >
          <TbX size={13} />
        </ActionIcon>
      </Group>
    </Paper>
  );
}
