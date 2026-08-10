import { TAG_KIND_ORDER, type TagGroup, type TagsResponse, type TestSummary } from '@hub/shared';
import {
  Badge,
  Button,
  Collapse,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { type ReactNode, useMemo, useState } from 'react';
import { TbCheck, TbChevronDown, TbChevronRight, TbSearch, TbTag, TbX } from 'react-icons/tb';
import { useT } from '~/i18n/index.js';
import { getTagLevel, matchTests } from '~/utils/tag-selection';

/** A tag's state in the picker. Clicking cycles off -> include -> exclude -> off. */
type TagState = 'off' | 'include' | 'exclude';

interface TagSelectorProps {
  tags: TagsResponse | undefined;
  isLoading: boolean;
  selectedTags: string[];
  onChange: (next: string[]) => void;
  /**
   * Tags whose tests must NOT run. Omit this pair to keep the two-state picker
   * (off <-> include) — a caller that cannot store exclusions must not offer a
   * third state the run would then ignore.
   */
  excludedTags?: string[];
  onExcludeChange?: (next: string[]) => void;
  /**
   * Where the "will run N tests" summary sits.
   *
   * `bottom` reads it as the RESULT of the picking just done and puts it next to
   * the button pressed afterwards, so the eye travels down once. `top` (default)
   * suits a form where the picker is one field among many.
   */
  matchPanelAt?: 'top' | 'bottom';
  /**
   * Fill the parent's height and make the category-group list the only scroll
   * region (used in the Run form, so the surrounding fields stay fixed and the
   * panel bottom sits flush). Default: autosize the list up to a capped height.
   */
  fill?: boolean;
}

/**
 * Loop tags reach the client inside the server's `case-id` / `domain` groups —
 * the shared taxonomy has no loop kind — so they are re-bucketed here into a
 * client-only group whose kind is not a `TagGroupKind`.
 */
const LOOP_KIND = 'loop';

type DisplayGroup = Omit<TagGroup, 'kind'> & { kind: string };

// Stable group display order — single source of truth: @hub/shared, with the
// client-only loop group appended after every taxonomy kind: loop cases are the
// weakest filter and the biggest bucket, so they belong at the bottom. A new
// shared kind still flows through ahead of it.
const DISPLAY_KIND_ORDER: readonly string[] = [...TAG_KIND_ORDER, LOOP_KIND];

/** Long-tail groups that start collapsed — hundreds of chips each otherwise. */
const INITIALLY_COLLAPSED: readonly string[] = ['case-id', LOOP_KIND];

function groupRank(kind: string): number {
  const index = DISPLAY_KIND_ORDER.indexOf(kind);
  return index === -1 ? DISPLAY_KIND_ORDER.length : index;
}

const GROUP_COLORS: Record<string, string> = {
  severity: 'red',
  'test-type': 'grape',
  'flow-type': 'orange',
  device: 'cyan',
  [LOOP_KIND]: 'violet',
  domain: 'teal',
  'domain-single': 'green',
  'case-id': 'gray',
};

/**
 * Scroll wrapper for the category-group list.
 * - `fill`: fills the parent's remaining height and scrolls, so ONLY this list
 *   scrolls while the surrounding form stays fixed (Run form).
 * - default: autosizes up to a capped height (e.g. schedule form).
 */
function GroupList({ fill, children }: { fill: boolean; children: ReactNode }) {
  if (fill) {
    return (
      // No border in `fill` mode: this list already sits inside the Run form's
      // card, so its own outline was a second box drawn 8px inside the first.
      // Grouping comes from the surrounding spacing instead.
      <Paper
        style={{
          overflow: 'hidden',
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* `contain` stops a wheel that reaches the end of the tag list from
            chaining into the page behind it and jumping the whole form. */}
        <ScrollArea
          type="auto"
          scrollbarSize={8}
          style={{ flex: 1, minHeight: 0, overscrollBehavior: 'contain' }}
        >
          {children}
        </ScrollArea>
      </Paper>
    );
  }
  return (
    <Paper withBorder style={{ overflow: 'hidden' }}>
      <ScrollArea.Autosize mah="40vh">{children}</ScrollArea.Autosize>
    </Paper>
  );
}

export function TagSelector({
  tags,
  isLoading,
  selectedTags,
  onChange,
  excludedTags,
  onExcludeChange,
  matchPanelAt = 'top',
  fill = false,
}: TagSelectorProps) {
  const t = useT();
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(INITIALLY_COLLAPSED));
  const [showMatchedTests, setShowMatchedTests] = useState(false);

  const tests = tags?.tests ?? [];
  const totalCount = tests.length;
  const excluded = excludedTags ?? [];

  // Tests that match current selection (deduped by id+title — reporters
  // sometimes emit the same logical test twice across scenarios).
  const matchedTests = useMemo<TestSummary[]>(() => {
    if (totalCount === 0) return [];
    const matched = matchTests(tests, selectedTags, excluded);
    const seen = new Set<string>();
    const unique: TestSummary[] = [];
    for (const test of matched) {
      const key = `${test.id}\u0001${test.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(test);
    }
    return unique;
  }, [tests, selectedTags, excluded, totalCount]);

  const matchingCount = matchedTests.length;
  const isFiltered = selectedTags.length > 0 || excluded.length > 0;
  const matchColor =
    matchingCount === 0 ? 'red' : isFiltered && matchingCount < totalCount ? 'green' : 'blue';

  function stateOf(tag: string): TagState {
    if (selectedTags.includes(tag)) return 'include';
    return excluded.includes(tag) ? 'exclude' : 'off';
  }

  /**
   * One click advances the tag: off -> include -> exclude -> off.
   *
   * Cycling in place keeps a single control per tag, so a tag can never be both
   * included and excluded, and no second picker has to be kept in sync. Without
   * an `onExcludeChange` the cycle collapses to off <-> include.
   */
  function cycle(tag: string) {
    const current = stateOf(tag);
    const withoutTag = selectedTags.filter((x) => x !== tag);
    const exclWithout = excluded.filter((x) => x !== tag);
    if (current === 'off') {
      onChange([...new Set([...selectedTags, tag])]);
      if (exclWithout.length !== excluded.length) onExcludeChange?.(exclWithout);
      return;
    }
    if (current === 'include') {
      onChange(withoutTag);
      if (onExcludeChange) onExcludeChange([...new Set([...excluded, tag])]);
      return;
    }
    onExcludeChange?.(exclWithout);
  }

  /**
   * Step BACK one state: exclude -> include -> off. Bound to right-click (and
   * Backspace), so overshooting the forward cycle costs one click on the chip
   * already under the pointer instead of two more laps around it.
   */
  function stepBack(tag: string) {
    const current = stateOf(tag);
    if (current === 'off') return;
    if (current === 'include') {
      onChange(selectedTags.filter((x) => x !== tag));
      return;
    }
    onExcludeChange?.(excluded.filter((x) => x !== tag));
    onChange([...new Set([...selectedTags, tag])]);
  }

  function toggleGroup(kind: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  // Sort groups in stable order, after lifting loop tags out of the server
  // groups into their own category (same predicate that drives AND/OR selection
  // semantics, so grouping and matching can never disagree).
  const orderedGroups = useMemo<DisplayGroup[]>(() => {
    if (!tags) return [];
    const groups: DisplayGroup[] = [];
    const loopTags: string[] = [];
    for (const group of tags.groups) {
      const rest: string[] = [];
      for (const tag of group.tags) {
        if (getTagLevel(tag) === LOOP_KIND) loopTags.push(tag);
        else rest.push(tag);
      }
      if (rest.length > 0) groups.push({ ...group, tags: rest });
    }
    if (loopTags.length > 0) {
      groups.push({ kind: LOOP_KIND, label: t('tagSelector.loopGroup'), tags: loopTags });
    }
    return groups.sort((a, b) => groupRank(a.kind) - groupRank(b.kind));
  }, [tags, t]);

  // Filter by search.
  const searchLower = search.toLowerCase();
  const filteredGroups = orderedGroups
    .map((g) => ({ ...g, tags: g.tags.filter((tag) => tag.toLowerCase().includes(searchLower)) }))
    .filter((g) => g.tags.length > 0);

  if (isLoading) {
    return (
      <Group gap="xs">
        <Loader size="xs" />
        <Text size="xs" c="dimmed">
          {t('run.loadingTags')}
        </Text>
      </Group>
    );
  }

  if (!tags || tags.all.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        {t('tagSelector.noTags')}
      </Text>
    );
  }

  /**
   * The "will run N tests" summary. One compact row — the count is a glance, not
   * a section — with the matched list folded away behind it.
   */
  const matchPanel =
    totalCount === 0 ? null : (
      <Paper
        withBorder
        px="xs"
        py={6}
        style={{
          flexShrink: 0,
          borderColor: `var(--mantine-color-${matchColor}-6)`,
          backgroundColor: `var(--mantine-color-${matchColor}-light)`,
        }}
      >
        <Stack gap={4}>
          {/* Exclusions live in THIS panel rather than a row of their own above the
              list: a row that appears with the first exclusion pushed every chip
              down, moving the next target out from under the pointer. Here the
              panel is always mounted, so nothing above it ever moves. */}
          {excluded.length > 0 && (
            <Group gap={6} wrap="wrap">
              <Text size="xs" fw={600} c="red.7">
                {t('tagSelector.excluded')}
              </Text>
              {excluded.map((tag) => (
                <Badge
                  key={tag}
                  size="sm"
                  color="red"
                  variant="light"
                  rightSection={<TbX size={10} />}
                  style={{ cursor: 'pointer' }}
                  role="button"
                  tabIndex={0}
                  aria-label={`${t('tagSelector.removeExclusion')} ${tag}`}
                  onClick={() => onExcludeChange?.(excluded.filter((x) => x !== tag))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onExcludeChange?.(excluded.filter((x) => x !== tag));
                    }
                  }}
                >
                  {tag}
                </Badge>
              ))}
            </Group>
          )}
          <Group justify="space-between" wrap="nowrap">
            <Group gap={6} wrap="nowrap">
              <TbCheck size={14} color={`var(--mantine-color-${matchColor}-7)`} />
              <Text size="xs" fw={700} c={`${matchColor}.8`}>
                {matchingCount === 0
                  ? t('tagSelector.noMatch')
                  : isFiltered
                    ? `${t('tagSelector.willRun')} ${matchingCount}/${totalCount} ${t('tagSelector.testsWord')}`
                    : `${t('tagSelector.willRun')} ${t('common.all')} ${matchingCount} ${t('tagSelector.testsWord')}`}
              </Text>
            </Group>
            {matchingCount > 0 && (
              <UnstyledButton
                onClick={() => setShowMatchedTests((v) => !v)}
                style={{ display: 'flex', alignItems: 'center', gap: 4 }}
              >
                <Text size="xs" c="dimmed">
                  {showMatchedTests ? t('tagSelector.hide') : t('tagSelector.show')}{' '}
                  {t('tagSelector.list')}
                </Text>
                <TbChevronDown
                  size={12}
                  style={{
                    transform: showMatchedTests ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 150ms',
                  }}
                />
              </UnstyledButton>
            )}
          </Group>
          <Collapse expanded={showMatchedTests && matchingCount > 0}>
            <ScrollArea.Autosize mah="25vh">
              <Stack gap={2}>
                {matchedTests.map((test, idx) => (
                  <Group
                    key={`${test.id}-${idx as number}`}
                    gap={6}
                    wrap="nowrap"
                    align="flex-start"
                  >
                    <Badge size="xs" color="gray" variant="light" style={{ flexShrink: 0 }}>
                      {test.id || '?'}
                    </Badge>
                    <Tooltip label={test.title} multiline maw={420} withArrow openDelay={300}>
                      <Text size="xs" lineClamp={1}>
                        {test.title}
                      </Text>
                    </Tooltip>
                  </Group>
                ))}
              </Stack>
            </ScrollArea.Autosize>
          </Collapse>
        </Stack>
      </Paper>
    );

  return (
    <Stack gap="xs" style={fill ? { flex: 1, minHeight: 0 } : undefined}>
      {matchPanelAt === 'top' && matchPanel}

      {/* ─── Header ─── */}
      <Group justify="space-between" style={{ flexShrink: 0 }}>
        <Group gap={6}>
          <TbTag size={14} color="var(--mantine-color-dimmed)" />
          <Text size="xs" fw={600} c="dimmed">
            {t('tagSelector.tags')} ({tags.all.length})
          </Text>
        </Group>
        {/* Always rendered, disabled when there is nothing to clear: appearing on
            the first selection used to grow this row and shove every chip below
            it, so the tag the user was aiming at moved out from under the mouse. */}
        <Button
          size="compact-xs"
          variant="subtle"
          color="red"
          disabled={!isFiltered}
          onClick={() => {
            onChange([]);
            onExcludeChange?.([]);
          }}
        >
          {t('common.clearAll')}
        </Button>
      </Group>

      {/* ─── Search ─── */}
      <TextInput
        size="xs"
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        placeholder={t('tagSelector.searchPlaceholder')}
        leftSection={<TbSearch size={12} />}
        style={{ flexShrink: 0 }}
        rightSection={
          search ? (
            <UnstyledButton onClick={() => setSearch('')}>
              <TbX size={12} />
            </UnstyledButton>
          ) : null
        }
      />

      {/* ─── Category groups (flat) — in `fill` mode this is the ONLY scroll
          region (the rest of the Run form stays fixed). ─── */}
      <GroupList fill={fill}>
        <Stack gap={0}>
          {filteredGroups.map((group) => {
            const color = GROUP_COLORS[group.kind] ?? 'teal';
            const isCollapsed = collapsed.has(group.kind);
            const selectedInGroup = group.tags.filter((tag) => selectedTags.includes(tag)).length;
            const excludedInGroup = group.tags.filter((tag) => excluded.includes(tag)).length;

            return (
              <div
                key={group.kind + group.label}
                style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}
              >
                {/* Group header */}
                <UnstyledButton
                  onClick={() => toggleGroup(group.kind)}
                  style={{
                    width: '100%',
                    padding: '6px 12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <Group gap={6} wrap="nowrap">
                    <TbChevronRight
                      size={12}
                      style={{
                        transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)',
                        transition: 'transform 150ms',
                      }}
                    />
                    <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                      {group.label}
                    </Text>
                    <Text size="xs" c="dimmed" fw={400}>
                      ({group.tags.length})
                    </Text>
                  </Group>
                  <Group gap={4} wrap="nowrap">
                    {selectedInGroup > 0 && (
                      <Badge size="xs" color="blue" circle>
                        {selectedInGroup}
                      </Badge>
                    )}
                    {excludedInGroup > 0 && (
                      <Badge size="xs" color="red" circle>
                        {excludedInGroup}
                      </Badge>
                    )}
                  </Group>
                </UnstyledButton>

                {/* Group tags */}
                <Collapse expanded={!isCollapsed}>
                  <Group gap={6} px="sm" pb="xs" wrap="wrap">
                    {group.tags.map((tag) => {
                      const state = stateOf(tag);
                      const detail = tags.details?.[tag];
                      const countLabel = detail
                        ? detail.tests.length === 1
                          ? detail.tests[0]?.title || tag
                          : `${detail.count} tests`
                        : tag;
                      // The tooltip carries the next action, so the third state
                      // is discoverable without a legend.
                      const nextActionKey =
                        state === 'off'
                          ? 'tagSelector.clickToInclude'
                          : state === 'include' && onExcludeChange
                            ? 'tagSelector.clickToExclude'
                            : 'tagSelector.clickToClear';
                      const hint =
                        state === 'off'
                          ? t(nextActionKey)
                          : `${t(nextActionKey)} · ${t('tagSelector.rightClickBack')}`;
                      return (
                        <Tooltip
                          key={tag}
                          label={`${countLabel} — ${hint}`}
                          withArrow
                          openDelay={300}
                          multiline
                          maw={420}
                        >
                          <Badge
                            size="sm"
                            variant={state === 'off' ? 'outline' : 'filled'}
                            color={
                              state === 'include' ? 'blue' : state === 'exclude' ? 'red' : color
                            }
                            style={{
                              cursor: 'pointer',
                              // Strike-through, not a prefix character: an excluded
                              // chip must stay the SAME WIDTH as its other states,
                              // or every chip after it reflows on each click and the
                              // next target slides out from under the pointer.
                              textDecoration: state === 'exclude' ? 'line-through' : undefined,
                            }}
                            role="button"
                            tabIndex={0}
                            aria-label={`${tag} — ${t(`tagSelector.state.${state}`)}`}
                            onClick={() => cycle(tag)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              stepBack(tag);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                cycle(tag);
                              } else if (e.key === 'Backspace') {
                                e.preventDefault();
                                stepBack(tag);
                              }
                            }}
                          >
                            {tag}
                            {detail && detail.count > 1 && group.kind !== 'case-id'
                              ? ` (${detail.count})`
                              : ''}
                          </Badge>
                        </Tooltip>
                      );
                    })}
                  </Group>
                </Collapse>
              </div>
            );
          })}
          {filteredGroups.length === 0 && (
            <Text size="xs" c="dimmed" p="sm">
              {t('tagSelector.noMatchSearch')} &ldquo;{search}&rdquo;
            </Text>
          )}
        </Stack>
      </GroupList>

      {matchPanelAt === 'bottom' && matchPanel}
    </Stack>
  );
}
