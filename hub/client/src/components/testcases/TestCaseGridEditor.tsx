import type {
  RunRequest,
  TestCaseDoc,
  TestCaseGrid,
  TestCaseStatusSyncResult,
  ToolId,
} from '@hub/shared';
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Group,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  TbAlertTriangle,
  TbChevronRight,
  TbPencil,
  TbPlayerPlay,
  TbPlus,
  TbRefresh,
} from 'react-icons/tb';
import { api } from '~/api/client.js';
import { qProjectTags, qTestCaseGrid } from '~/api/queries.js';
import { InlineAlert } from '~/components/InlineAlert.js';
import { ListSkeleton } from '~/components/Skeletons.js';
import { toast } from '~/components/Toast.js';
import { useT } from '~/i18n/index.js';
import { useNavigationStore } from '~/stores/navigation.js';
import { type CoverageScan, isCaseRunnable, isCoverageKnown } from '~/utils/case-runnable.js';
import { applyEnter } from '~/utils/list-continuation.js';
import { buildTagExpr } from '~/utils/tag-selection.js';

// Standard dropdown values — mirror config/pipeline.static.json `test_case_vocab`
// (Status has no pipeline vocab; these are Hub-local, aligned with run outcomes).
const SEVERITY = ['Critical', 'High', 'Medium', 'Low'];
const COLUMN_OPTIONS: Record<string, string[]> = {
  'Test Type': ['Positive', 'Negative', 'Edge'],
  Severity: SEVERITY,
  Priority: SEVERITY,
  Remark: ['verified-live', 'needs-live-confirm'],
  Status: ['Pass', 'Fail', 'Blocked', 'Skipped'],
};
const LOCKED_HEADERS = new Set(['Test Case ID', 'Module', 'Requirement Ref ID']);
const READONLY_HEADERS = new Set(['Updated At', 'Edited By']);
const ID_HEADER = 'Test Case ID';
const TITLE_HEADER = 'Test Scenario';
// Compact columns shown on the collapsed row; the rest appear only once a row
// is expanded (keeps the grid scannable when cells wrap to many lines).
const SUMMARY_HEADERS = [
  'Test Case ID',
  'Test Scenario',
  'Requirement Ref ID',
  'Test Type',
  'Severity',
  'Priority',
  // Status is where a run's outcome lands, so it belongs on the collapsed row —
  // otherwise the result of a run is only visible after expanding every case.
  'Status',
];

const STATUS_HEADER = 'Status';
/** Status value → badge colour. Text is always shown too, never colour alone. */
const STATUS_COLOR: Record<string, string> = {
  Pass: 'green',
  Fail: 'red',
  Blocked: 'orange',
  Skipped: 'gray',
};

// Wrap cell text the way Excel's "wrap text" does: honor explicit newlines and
// let long content flow onto multiple lines instead of being clipped.
const CELL_WRAP = { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } as const;

function headerName(header: string[], col: number): string {
  return (header[col] ?? '').trim();
}

function findCol(header: string[], name: string): number {
  return header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
}

/**
 * Fields written as prose or as a numbered / bulleted list. These get a growing
 * textarea where Enter makes a new line, instead of a single-line input that
 * would silently flatten the value the doc is supposed to hold.
 */
const MULTILINE_HEADERS = new Set([
  'Test Scenario',
  'Pre-Condition',
  'Test Data Requirement',
  'Test Data Example',
  'Test Steps',
  'Expected Result',
  'Actual Result',
  'Remark',
]);

/**
 * Field editor — mounted ONLY for the cell being edited, so the grid renders
 * plain text instead of many live inputs.
 *
 * An edit is explicitly committed with Save or dropped with Cancel; blurring does
 * NOT write. Auto-committing on blur made every stray click a silent save, so a
 * mistyped step was indistinguishable from an intended change.
 *
 * Single-line fields keep Enter as "save" (fastest for a one-word value).
 * Multi-line fields give Enter to the text — with list continuation — and are
 * saved with the button or Ctrl/Cmd+Enter.
 */
function FieldEditor({
  value,
  multiline,
  onCommit,
  onCancel,
}: {
  value: string;
  multiline: boolean;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const dirty = draft !== value;

  /** Enter inside a textarea: continue the list, keeping the caret after the marker. */
  function handleAreaEnter(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    const { value: next, caret } = applyEnter(el.value, el.selectionStart ?? el.value.length);
    e.preventDefault();
    setDraft(next);
    // Restore the caret after React has rendered the new value.
    requestAnimationFrame(() => {
      const area = areaRef.current;
      if (area) area.setSelectionRange(caret, caret);
    });
  }

  return (
    <Stack gap={4}>
      {multiline ? (
        <Textarea
          ref={areaRef}
          size="xs"
          autoFocus
          autosize
          minRows={3}
          maxRows={14}
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onCommit(draft);
            else if (e.key === 'Enter') handleAreaEnter(e);
            else if (e.key === 'Escape') onCancel();
          }}
          styles={{ input: { fontFamily: 'inherit' } }}
        />
      ) : (
        <TextInput
          size="xs"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommit(draft);
            else if (e.key === 'Escape') onCancel();
          }}
        />
      )}
      <Group gap={6}>
        <Button size="compact-xs" onClick={() => onCommit(draft)} disabled={!dirty}>
          {t('common.save')}
        </Button>
        <Button size="compact-xs" variant="subtle" color="gray" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Text size="xs" c="dimmed">
          {multiline ? t('testcases.editorHintMultiline') : t('testcases.editorHint')}
        </Text>
      </Group>
    </Stack>
  );
}

interface TestCaseGridEditorProps {
  doc: TestCaseDoc;
  tool: ToolId;
  type: string;
  project: string;
}

interface CellPos {
  row: number;
  col: number;
}

export function TestCaseGridEditor({ doc, tool, type, project }: TestCaseGridEditorProps) {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const setPendingRunConfig = useNavigationStore((s) => s.setPendingRunConfig);
  const key = ['tc-grid', doc.path] as const;
  const [sheetIdx, setSheetIdx] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editCell, setEditCell] = useState<CellPos | null>(null);

  // Selection / expansion / open editor are per-sheet/per-doc — reset on change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the sheet/doc changes
  useEffect(() => {
    setSelected(new Set());
    setExpanded(new Set());
    setEditCell(null);
  }, [sheetIdx, doc.path]);

  const gridQ = useQuery(qTestCaseGrid(doc.path));

  // Which case ids are actually runnable — a case is runnable only when some
  // spec declares `@<caseId>` as a tag. Reuses the Run page's cached tag scan
  // (same query key) so opening the grid adds no extra backend work when the
  // user has already visited Run for this project.
  const tagsQ = useQuery(qProjectTags(tool, type, project));
  const scan: CoverageScan = useMemo(
    () => ({
      coveredIds: new Set((tagsQ.data?.all ?? []).map((tag) => tag.replace(/^@/, ''))),
      settled: tagsQ.isSuccess,
      failed: tagsQ.isError,
    }),
    [tagsQ.data, tagsQ.isSuccess, tagsQ.isError],
  );
  const coverageKnown = isCoverageKnown(scan);
  const isRunnable = (id: string) => isCaseRunnable(scan, id);

  const save = useMutation({
    mutationFn: (body: { row: number; col: number; value: string }) =>
      api.post<TestCaseGrid>('/api/testcases/edit', { path: doc.path, sheet: sheetIdx, ...body }),
    onSuccess: (grid) => qc.setQueryData(key, grid),
  });
  const addRow = useMutation({
    mutationFn: () =>
      api.post<TestCaseGrid>('/api/testcases/add-row', { path: doc.path, sheet: sheetIdx }),
    onSuccess: (grid) => qc.setQueryData(key, grid),
  });
  const sync = useMutation({
    mutationFn: () =>
      api.post<TestCaseStatusSyncResult>('/api/testcases/sync-status', { path: doc.path }),
    onSuccess: (res) => {
      qc.setQueryData(key, res.grid);
      if (res.runAt === null) toast.error(t('testcases.noRun'));
      // A run that matched nothing is a coverage gap, not a failed sync — say so,
      // otherwise it reads as "the Hub did nothing".
      else if (res.matched === 0) toast.error(t('testcases.syncNoMatch'));
      else toast.success(`${res.matched}/${res.total} ${t('testcases.syncMatched')}`);
    },
  });

  /**
   * Preset the Run page with the given case ids and jump there. Doc ids are bare
   * (`TC-…`) but the Hub's tag system is `@`-prefixed, so prefix + build the grep
   * expression. Ids no spec covers are dropped so the Run page never opens empty.
   */
  function runIds(ids: string[]) {
    const wanted = ids.map((s) => s.trim()).filter(Boolean);
    const runnable = wanted.filter((id) => isCaseRunnable(scan, id));
    if (runnable.length === 0) {
      toast.error(coverageKnown ? t('testcases.noRunnable') : t('testcases.noIds'));
      return;
    }
    const atTags = runnable.map((id) => (id.startsWith('@') ? id : `@${id}`));
    const config: RunRequest = { tool, type, project, mode: 'local', tag: buildTagExpr(atTags) };
    setPendingRunConfig(config);
    navigate({ to: '/run' });
  }

  // Hold the whole grid until the rows AND the coverage scan have both arrived.
  // Rendering on rows alone showed every case as a runnable link for as long as
  // the tag scan was in flight, so a case with no spec could be clicked to run.
  if (gridQ.isLoading || tagsQ.isLoading) return <ListSkeleton rows={6} />;
  const grid = gridQ.data;
  const sheets = grid?.sheets ?? [];
  const sheet = sheets[Math.min(sheetIdx, Math.max(0, sheets.length - 1))];
  if (!grid || !sheet) {
    return (
      <Text size="xs" c="dimmed">
        {t('testcases.none')}
      </Text>
    );
  }
  const header = sheet.rows[0] ?? [];
  const idCol = findCol(header, ID_HEADER);
  const canRun = idCol >= 0;
  const dataRows = sheet.rows.slice(1);
  const summaryCols = SUMMARY_HEADERS.map((name) => findCol(header, name)).filter((c) => c >= 0);
  const detailColSpan = 1 + (canRun ? 1 : 0) + summaryCols.length;

  // Row indices (1-based into sheet.rows) whose id maps to a runnable spec.
  const runnableRows = dataRows
    .map((_, di) => di + 1)
    .filter((r) => {
      const id = (sheet.rows[r]?.[idCol] ?? '').trim();
      return id !== '' && isRunnable(id);
    });

  const toggleRow = (r: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(r)) next.delete(r);
      else next.add(r);
      return next;
    });
  const toggleAll = () =>
    setSelected((prev) => (prev.size === runnableRows.length ? new Set() : new Set(runnableRows)));
  const toggleExpand = (r: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(r)) next.delete(r);
      else next.add(r);
      return next;
    });
  const selectedIds = [...selected]
    .map((r) => (sheet.rows[r]?.[idCol] ?? '').trim())
    .filter(Boolean);

  /** The editable control for a single cell (used in the expanded detail). */
  function cellControl(rowIdx: number, col: number, value: string): ReactNode {
    const name = headerName(header, col);
    const options = COLUMN_OPTIONS[name];
    const editing = editCell?.row === rowIdx && editCell?.col === col;
    const commit = (next: string) => {
      setEditCell(null);
      if (next !== value) save.mutate({ row: rowIdx, col, value: next });
    };
    const cancel = () => setEditCell(null);

    if (READONLY_HEADERS.has(name)) {
      return (
        <Text size="xs" c="dimmed" style={CELL_WRAP}>
          {value || '—'}
        </Text>
      );
    }
    if (LOCKED_HEADERS.has(name) && value.trim() !== '') {
      return (
        <Text size="xs" ff="monospace" style={CELL_WRAP}>
          {value}
        </Text>
      );
    }
    if (editing && options) {
      return (
        <Select
          size="xs"
          autoFocus
          defaultDropdownOpened
          data={value && !options.includes(value) ? [value, ...options] : options}
          value={value || null}
          clearable
          onChange={(v) => commit(v ?? '')}
          onBlur={cancel}
          comboboxProps={{ withinPortal: true }}
        />
      );
    }
    if (editing) {
      return (
        <FieldEditor
          value={value}
          multiline={MULTILINE_HEADERS.has(name)}
          onCommit={commit}
          onCancel={cancel}
        />
      );
    }
    // Read mode has to LOOK editable: a hover surface + a pencil, not just a
    // title attribute. Without it the only clue was the cursor.
    return (
      <UnstyledButton
        onClick={() => setEditCell({ row: rowIdx, col })}
        aria-label={`${t('testcases.clickToEdit')}: ${name}`}
        style={{ width: '100%', borderRadius: 4 }}
        className="tc-editable"
      >
        <Group gap={6} align="flex-start" wrap="nowrap" px={6} py={3}>
          <Text size="xs" c={value ? undefined : 'dimmed'} style={{ ...CELL_WRAP, flex: 1 }}>
            {value || '—'}
          </Text>
          <TbPencil size={12} style={{ flexShrink: 0, marginTop: 2, opacity: 0.45 }} aria-hidden />
        </Group>
      </UnstyledButton>
    );
  }

  /** The Case ID summary cell — a Run link when runnable, else a dimmed hint. */
  function idCell(idVal: string): ReactNode {
    if (!idVal) {
      return (
        <Text size="xs" c="dimmed">
          —
        </Text>
      );
    }
    if (isRunnable(idVal)) {
      return (
        <Tooltip label={t('testcases.runCase')} withArrow>
          <Anchor
            component="button"
            type="button"
            size="xs"
            ff="monospace"
            style={{ whiteSpace: 'nowrap' }}
            onClick={() => runIds([idVal])}
          >
            {idVal}
          </Anchor>
        </Tooltip>
      );
    }
    return (
      <Tooltip label={t('testcases.noSpec')} withArrow>
        <Text size="xs" ff="monospace" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
          {idVal}
        </Text>
      </Tooltip>
    );
  }

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Group gap="xs">
          <Text size="sm" fw={600}>
            {doc.name}
          </Text>
          {grid.edited && (
            <Badge size="xs" color="orange" variant="light">
              {t('testcases.editedBadge')}
            </Badge>
          )}
        </Group>
        <Group gap="xs">
          {canRun && (
            <Button
              size="compact-xs"
              variant="light"
              leftSection={<TbPlayerPlay size={12} />}
              disabled={selectedIds.length === 0}
              onClick={() => runIds(selectedIds)}
            >
              {t('testcases.runSelected')} ({selectedIds.length})
            </Button>
          )}
          <Button
            size="compact-xs"
            variant="light"
            color="gray"
            leftSection={<TbRefresh size={12} />}
            onClick={() => sync.mutate()}
            loading={sync.isPending}
          >
            {t('testcases.syncStatus')}
          </Button>
          <Button
            size="compact-xs"
            variant="light"
            leftSection={<TbPlus size={12} />}
            onClick={() => addRow.mutate()}
            loading={addRow.isPending}
          >
            {t('testcases.addRow')}
          </Button>
        </Group>
      </Group>

      {sheets.length > 1 && (
        <SegmentedControl
          size="xs"
          value={String(Math.min(sheetIdx, sheets.length - 1))}
          onChange={(v) => setSheetIdx(Number(v))}
          data={sheets.map((s, i) => ({ value: String(i), label: s.name }))}
        />
      )}

      <InlineAlert icon={<TbAlertTriangle size={16} />} message={t('testcases.editHint')} />

      <ScrollArea.Autosize mah="62vh">
        <Table striped withTableBorder highlightOnHover verticalSpacing={4} stickyHeader>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={36} />
              {canRun && (
                <Table.Th w={40}>
                  <Checkbox
                    size="xs"
                    checked={runnableRows.length > 0 && selected.size === runnableRows.length}
                    indeterminate={selected.size > 0 && selected.size < runnableRows.length}
                    onChange={toggleAll}
                    aria-label={t('testcases.runSelected')}
                  />
                </Table.Th>
              )}
              {summaryCols.map((col) => (
                <Table.Th key={col} style={{ whiteSpace: 'nowrap' }}>
                  <Text size="xs" fw={600}>
                    {header[col]}
                  </Text>
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {dataRows.map((row, di) => {
              const rowIdx = di + 1;
              const idVal = (row[idCol] ?? '').trim();
              const runnable = idVal !== '' && isRunnable(idVal);
              const isOpen = expanded.has(rowIdx);
              return (
                <Fragment key={rowIdx}>
                  <Table.Tr>
                    <Table.Td>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="sm"
                        aria-label={isOpen ? t('common.collapse') : t('common.expand')}
                        onClick={() => toggleExpand(rowIdx)}
                      >
                        <TbChevronRight
                          size={14}
                          style={{
                            transform: isOpen ? 'rotate(90deg)' : 'none',
                            transition: 'transform 150ms',
                          }}
                        />
                      </ActionIcon>
                    </Table.Td>
                    {canRun && (
                      <Table.Td>
                        <Checkbox
                          size="xs"
                          checked={selected.has(rowIdx)}
                          disabled={idVal !== '' && !runnable}
                          onChange={() => toggleRow(rowIdx)}
                          aria-label={idVal}
                        />
                      </Table.Td>
                    )}
                    {summaryCols.map((col) => {
                      const name = headerName(header, col);
                      const value = row[col] ?? '';
                      if (name === ID_HEADER) {
                        return <Table.Td key={col}>{idCell(idVal)}</Table.Td>;
                      }
                      if (name === STATUS_HEADER) {
                        return (
                          <Table.Td key={col} style={{ verticalAlign: 'top' }}>
                            {value ? (
                              <Badge
                                size="xs"
                                variant="light"
                                color={STATUS_COLOR[value] ?? 'gray'}
                              >
                                {value}
                              </Badge>
                            ) : (
                              <Text size="xs" c="dimmed">
                                —
                              </Text>
                            )}
                          </Table.Td>
                        );
                      }
                      return (
                        <Table.Td key={col} style={{ verticalAlign: 'top' }}>
                          <Text
                            size="xs"
                            lineClamp={name === TITLE_HEADER ? 2 : 1}
                            c={value ? undefined : 'dimmed'}
                          >
                            {value || '—'}
                          </Text>
                        </Table.Td>
                      );
                    })}
                  </Table.Tr>
                  {isOpen && (
                    <Table.Tr>
                      <Table.Td
                        colSpan={detailColSpan}
                        style={{ background: 'var(--mantine-color-default-hover)' }}
                      >
                        <Stack gap={6} py={4}>
                          {header.map((h, col) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: detail fields are positional
                            <Group key={col} gap="sm" align="flex-start" wrap="nowrap">
                              <Text
                                size="xs"
                                fw={600}
                                c="dimmed"
                                style={{ width: 170, flexShrink: 0, whiteSpace: 'nowrap' }}
                                truncate
                              >
                                {h}
                              </Text>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                {cellControl(rowIdx, col, row[col] ?? '')}
                              </div>
                            </Group>
                          ))}
                        </Stack>
                      </Table.Td>
                    </Table.Tr>
                  )}
                </Fragment>
              );
            })}
          </Table.Tbody>
        </Table>
      </ScrollArea.Autosize>
    </Stack>
  );
}
