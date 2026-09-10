import type { Bookmark, RunRequest } from '@hub/shared';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Collapse,
  Group,
  Loader,
  Modal,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  TbBookmark,
  TbCheck,
  TbChevronRight,
  TbDeviceFloppy,
  TbPencil,
  TbSearch,
  TbTrash,
  TbX,
} from 'react-icons/tb';
import { api } from '~/api/client.js';
import { confirmDialog } from '~/components/confirmDialog.js';
import { EmptyState } from '~/components/EmptyState.js';
import { toast } from '~/components/Toast.js';
import { useTools } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';
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
      queryClient.invalidateQueries({ queryKey: ['bookmarks'] });
    },
  });
}

/** Stable-ish accent per tool so Playwright/Robot/k6 groups are tellable at a glance. */
const TOOL_COLORS = ['blue', 'grape', 'teal', 'orange', 'cyan', 'pink', 'indigo'] as const;
function toolColor(toolId: string): string {
  let h = 0;
  for (let i = 0; i < toolId.length; i++) h = (h * 31 + toolId.charCodeAt(i)) | 0;
  return TOOL_COLORS[Math.abs(h) % TOOL_COLORS.length] as string;
}

/** The bits that vary within a tool/type/project group — shown on each row. */
function leafDigest(c: RunRequest): string {
  const parts: string[] = [c.mode];
  if (c.tag) parts.push(c.tag);
  if (c.section) parts.push(c.section);
  if (c.performanceType) parts.push(c.performanceType);
  if (c.headless) parts.push(c.headless);
  if (c.silent) parts.push('silent');
  if (c.discardReport) parts.push('no report');
  if (c.noTrack) parts.push('no-track');
  return parts.filter(Boolean).join(' · ');
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
  items: Bookmark[];
}

/** tool → type · project groups, sorted by label then type then project. */
function groupBookmarks(
  list: Bookmark[],
  query: string,
  tools: ReturnType<typeof useTools>['data'],
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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);

  const bookmarks = useQuery<Bookmark[]>({
    queryKey: ['bookmarks'],
    queryFn: () => api.get('/api/bookmarks'),
    enabled: opened,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/bookmarks/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['bookmarks'] }),
  });

  const list = bookmarks.data ?? [];

  const { groups } = useMemo(
    () => groupBookmarks(list, q.trim().toLowerCase(), tools),
    [list, q, tools],
  );

  // A live search re-expands everything: a collapsed group whose child matched
  // must not stay hidden. Clear the manual collapse set whenever the query is
  // non-empty so every match is visible without a click.
  const searching = q.trim().length > 0;
  const isCollapsed = (key: string) => !searching && collapsed.has(key);

  function toggleGroup(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function openModal() {
    setQ('');
    setCollapsed(new Set());
    setEditingId(null);
    setOpened(true);
  }

  function load(config: RunRequest) {
    onLoad(config);
    setOpened(false);
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

  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed.has(g.key));
  function toggleAll() {
    if (allCollapsed) setCollapsed(new Set());
    else setCollapsed(new Set(groups.map((g) => g.key)));
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
          <Group gap={8}>
            <TbBookmark size={18} />
            <Text fw={600}>{t('bookmark.load')}</Text>
            <Badge size="sm" variant="light" circle>
              {list.length}
            </Badge>
          </Group>
        }
        size="lg"
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
            <Stack gap="xs">
              {groups.map((g) => (
                <Paper key={g.key} withBorder radius="md" p="xs">
                  <UnstyledButton
                    onClick={() => toggleGroup(g.key)}
                    aria-expanded={!isCollapsed(g.key)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      minWidth: 0,
                    }}
                  >
                    <TbChevronRight
                      size={15}
                      style={{
                        transform: isCollapsed(g.key) ? 'none' : 'rotate(90deg)',
                        transition: 'transform 150ms ease',
                        opacity: 0.6,
                        flexShrink: 0,
                      }}
                    />
                    <Badge
                      size="sm"
                      variant="dot"
                      color={toolColor(g.tool)}
                      style={{ flexShrink: 0 }}
                    >
                      {toolLabel(g.tool, tools)}
                    </Badge>
                    <Text size="sm" fw={500} truncate style={{ flex: 1, textAlign: 'left' }}>
                      {g.type} · {g.project}
                    </Text>
                    <Badge size="xs" variant="light" color="gray" circle style={{ flexShrink: 0 }}>
                      {g.items.length}
                    </Badge>
                  </UnstyledButton>
                  <Collapse expanded={!isCollapsed(g.key)}>
                    <SimpleGrid cols={{ base: 1, xs: 2, sm: 3 }} spacing="xs" pt="xs">
                      {g.items.map((bm) =>
                        editingId === bm.id ? (
                          <InlineEdit
                            key={bm.id}
                            bookmark={bm}
                            getConfig={getConfig}
                            onDone={() => setEditingId(null)}
                          />
                        ) : (
                          <BookmarkChip
                            key={bm.id}
                            bookmark={bm}
                            onApply={() => load(bm.config)}
                            onEdit={() => setEditingId(bm.id)}
                            onDelete={() => handleDelete(bm.id)}
                          />
                        ),
                      )}
                    </SimpleGrid>
                  </Collapse>
                </Paper>
              ))}
            </Stack>
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
function BookmarkChip({
  bookmark,
  onApply,
  onEdit,
  onDelete,
}: {
  bookmark: Bookmark;
  onApply: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const digest = leafDigest(bookmark.config);
  return (
    <Paper withBorder radius="sm" px={8} py={6} h="100%">
      <Group gap={4} wrap="nowrap" h="100%" align="flex-start">
        <Tooltip label={digest || t('bookmark.apply')} withArrow openDelay={400} multiline>
          <UnstyledButton onClick={onApply} style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}>
            <Box>
              <Text size="xs" fw={600} truncate>
                {bookmark.name}
              </Text>
              {digest && (
                <Text size="xs" c="dimmed" lineClamp={2}>
                  {digest}
                </Text>
              )}
            </Box>
          </UnstyledButton>
        </Tooltip>
        <Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="xs"
            onClick={onEdit}
            aria-label={t('bookmark.edit')}
          >
            <TbPencil size={12} />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            color="red"
            size="xs"
            onClick={onDelete}
            aria-label={t('bookmark.delete')}
          >
            <TbTrash size={12} />
          </ActionIcon>
        </Group>
      </Group>
    </Paper>
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
      queryClient.invalidateQueries({ queryKey: ['bookmarks'] });
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
