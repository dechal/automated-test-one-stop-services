import type { TestCaseDoc, TestCaseDocGrouped, TestCaseModule, ToolId } from '@hub/shared';
import {
  Badge,
  Button,
  Collapse,
  Group,
  Menu,
  Modal,
  Paper,
  Select,
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
  TbChecklist,
  TbChevronRight,
  TbDownload,
  TbEye,
  TbFilePlus,
  TbFileSpreadsheet,
  TbSearch,
  TbTable,
} from 'react-icons/tb';
import { api } from '~/api/client.js';
import { qAllTestCaseDocs, qProjectList, qProjectTypes, qTestCaseModules } from '~/api/queries.js';
import { EmptyState } from '~/components/EmptyState.js';
import { FormModal } from '~/components/FormModal.js';
import { PageHeader } from '~/components/PageHeader.js';
import { ListSkeleton } from '~/components/Skeletons.js';
import { toast } from '~/components/Toast.js';
import { TestCaseGridEditor } from '~/components/testcases/TestCaseGridEditor.js';
import { useToolOptions, useTools } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';
import { toolLabel } from '~/utils/tool-label.js';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `source` streams the untouched doc; `result` streams the overlay-merged xlsx. */
function downloadUrl(docPath: string, variant: 'source' | 'result'): string {
  return `/api/testcases/download?path=${encodeURIComponent(docPath)}&variant=${variant}`;
}

interface DocGroup {
  key: string;
  tool: string;
  type: string;
  project: string;
  items: TestCaseDocGrouped[];
}

/** `query` must already be trimmed + lowercased; an empty query matches everything. */
function matchesQuery(doc: TestCaseDocGrouped, query: string): boolean {
  if (!query) return true;
  return (
    doc.name.toLowerCase().includes(query) ||
    doc.relPath.toLowerCase().includes(query) ||
    doc.project.toLowerCase().includes(query) ||
    doc.type.toLowerCase().includes(query) ||
    doc.tool.toLowerCase().includes(query)
  );
}

export function TestCasesPage() {
  const t = useT();
  const qc = useQueryClient();
  const toolOptions = useToolOptions();
  const tools = useTools().data ?? [];

  // Filters narrow the full list; empty = show everything. `filterTool/Type/Project`
  // double as the axis the create form needs, so a full selection also enables New.
  const [filterTool, setFilterTool] = useState<ToolId | ''>('');
  const [filterType, setFilterType] = useState('');
  const [filterProject, setFilterProject] = useState('');
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const [openDoc, setOpenDoc] = useState<TestCaseDocGrouped | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newModule, setNewModule] = useState<string | null>(null);

  const allDocsQ = useQuery(qAllTestCaseDocs());
  const typesQ = useQuery(qProjectTypes(filterTool));
  const projectsQ = useQuery(qProjectList(filterTool, filterType));

  const ready = !!filterTool && !!filterType && !!filterProject;
  const modulesQ = useQuery({
    ...qTestCaseModules(filterTool, filterType, filterProject),
    enabled: createOpen && ready,
  });

  const create = useMutation({
    mutationFn: (moduleName: string) =>
      api.post<TestCaseDoc>('/api/testcases/create', {
        tool: filterTool,
        type: filterType,
        project: filterProject,
        module: moduleName,
      }),
    onSuccess: (doc) => {
      setCreateOpen(false);
      setNewModule(null);
      qc.invalidateQueries({ queryKey: ['testcases-all'] });
      qc.invalidateQueries({
        queryKey: ['testcase-modules', filterTool, filterType, filterProject],
      });
      toast.success(`${t('testcases.created')}: ${doc.name}`);
      setOpenDoc({ ...doc, tool: filterTool as ToolId, type: filterType, project: filterProject });
    },
  });

  const onTool = (v: string | null) => {
    setFilterTool((v as ToolId) ?? '');
    setFilterType('');
    setFilterProject('');
  };
  const onType = (v: string | null) => {
    setFilterType(v ?? '');
    setFilterProject('');
  };

  const list = allDocsQ.data ?? [];
  const query = q.trim().toLowerCase();

  const { groups, total } = useMemo(() => {
    const matched = list.filter(
      (d) =>
        (!filterTool || d.tool === filterTool) &&
        (!filterType || d.type === filterType) &&
        (!filterProject || d.project === filterProject) &&
        matchesQuery(d, query),
    );
    const map = new Map<string, DocGroup>();
    for (const doc of matched) {
      const key = `${doc.tool}|${doc.type}|${doc.project}`;
      const g = map.get(key);
      if (g) g.items.push(doc);
      else
        map.set(key, { key, tool: doc.tool, type: doc.type, project: doc.project, items: [doc] });
    }
    for (const g of map.values()) g.items.sort((a, b) => a.name.localeCompare(b.name));
    const sorted = [...map.values()].sort(
      (a, b) =>
        toolLabel(a.tool, tools).localeCompare(toolLabel(b.tool, tools)) ||
        a.type.localeCompare(b.type) ||
        a.project.localeCompare(b.project),
    );
    return { groups: sorted, total: matched.length };
  }, [list, filterTool, filterType, filterProject, query, tools]);

  // A live search re-expands everything so a collapsed group whose doc matched
  // is not hidden; manual collapse only applies when not searching.
  const searching = query.length > 0;
  const isCollapsed = (key: string) => !searching && collapsed.has(key);
  function toggleGroup(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed.has(g.key));
  function toggleAll() {
    if (allCollapsed) setCollapsed(new Set());
    else setCollapsed(new Set(groups.map((g) => g.key)));
  }

  const moduleOptions = (modulesQ.data ?? []).map((m: TestCaseModule) => ({
    value: m.name,
    label: m.docRelPath ? `${m.name} — ${t('testcases.moduleHasDoc')}` : m.name,
    disabled: !!m.docRelPath,
  }));
  const creatable = moduleOptions.filter((o) => !o.disabled);

  return (
    <Stack gap="md">
      <PageHeader
        title={t('testcases.title')}
        description={t('nav.testCases.desc')}
        actions={
          <Tooltip label={t('testcases.selectProjectFirst')} disabled={ready} withArrow>
            <Button
              size="xs"
              leftSection={<TbFilePlus size={14} />}
              disabled={!ready}
              onClick={() => setCreateOpen(true)}
            >
              {t('testcases.newDoc')}
            </Button>
          </Tooltip>
        }
      />

      <Paper withBorder p="md">
        <Stack gap="sm">
          <TextInput
            size="xs"
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            placeholder={t('testcases.searchPlaceholder')}
            leftSection={<TbSearch size={14} />}
          />
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
            <Select
              label={t('run.tool')}
              size="xs"
              clearable
              data={toolOptions}
              value={filterTool || null}
              onChange={onTool}
              placeholder={t('common.all')}
            />
            <Select
              label={t('table.type')}
              size="xs"
              clearable
              data={typesQ.data ?? []}
              value={filterType || null}
              onChange={onType}
              placeholder={t('common.all')}
              disabled={!filterTool}
            />
            <Select
              label={t('run.project')}
              size="xs"
              clearable
              searchable
              data={projectsQ.data ?? []}
              value={filterProject || null}
              onChange={(v) => setFilterProject(v ?? '')}
              placeholder={t('common.all')}
              disabled={!filterType}
            />
          </SimpleGrid>
        </Stack>
      </Paper>

      {allDocsQ.isLoading ? (
        <ListSkeleton />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<TbChecklist size={48} color="var(--mantine-color-dimmed)" />}
          description={t('testcases.noneAll')}
        />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<TbChecklist size={48} color="var(--mantine-color-dimmed)" />}
          description={t('testcases.noMatch')}
        />
      ) : (
        <Stack gap="xs">
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              {t('testcases.showingCount')
                .replace('{docs}', String(total))
                .replace('{groups}', String(groups.length))}
            </Text>
            {groups.length > 1 && (
              <Button size="compact-xs" variant="subtle" color="gray" onClick={toggleAll}>
                {allCollapsed ? t('testcases.expandAll') : t('testcases.collapseAll')}
              </Button>
            )}
          </Group>
          {groups.map((g) => (
            <Paper key={g.key} withBorder p="xs">
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
                <Badge size="sm" variant="light" color="gray" style={{ flexShrink: 0 }}>
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
                <Stack gap="xs" pt="xs">
                  {g.items.map((doc) => (
                    <DocRow
                      key={doc.path}
                      doc={doc}
                      active={openDoc?.path === doc.path}
                      onOpen={() => setOpenDoc(doc)}
                    />
                  ))}
                </Stack>
              </Collapse>
            </Paper>
          ))}
        </Stack>
      )}

      <Modal opened={!!openDoc} onClose={() => setOpenDoc(null)} title={openDoc?.name} size="90%">
        {openDoc && (
          <TestCaseGridEditor
            doc={openDoc}
            tool={openDoc.tool}
            type={openDoc.type}
            project={openDoc.project}
          />
        )}
      </Modal>

      <FormModal
        opened={createOpen}
        onClose={() => {
          setCreateOpen(false);
          setNewModule(null);
        }}
        title={t('testcases.newDocTitle')}
        submitLabel={t('testcases.newDoc')}
        onSubmit={() => newModule && create.mutate(newModule)}
        submitDisabled={!newModule}
        loading={create.isPending}
        error={create.error ? create.error.message : null}
      >
        <Text size="xs" c="dimmed">
          {t('testcases.newDocHint')}
        </Text>
        <Select
          label={t('testcases.module')}
          size="xs"
          searchable
          data={moduleOptions}
          value={newModule}
          onChange={setNewModule}
          placeholder={
            modulesQ.isLoading
              ? t('common.loading')
              : creatable.length === 0
                ? t('testcases.noModulesLeft')
                : t('testcases.module')
          }
          disabled={modulesQ.isLoading || creatable.length === 0}
        />
        {newModule && (
          <Text size="xs" c="dimmed" ff="monospace">
            docs/{newModule}/{newModule}_test-case.xlsx
          </Text>
        )}
      </FormModal>
    </Stack>
  );
}

/** One test-case doc as a row: name + path, badges, open + download menu. */
function DocRow({
  doc,
  active,
  onOpen,
}: {
  doc: TestCaseDocGrouped;
  active: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  return (
    <Paper withBorder p="sm">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <TbFileSpreadsheet
            size={20}
            color={
              doc.ext === 'csv' ? 'var(--mantine-color-teal-6)' : 'var(--mantine-color-green-6)'
            }
          />
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text size="sm" fw={500} truncate>
              {doc.name}
            </Text>
            <Text size="xs" c="dimmed" ff="monospace" truncate>
              {doc.relPath}
            </Text>
          </Stack>
        </Group>
        <Group gap="xs" wrap="nowrap">
          {doc.edited && (
            <Badge size="xs" variant="light" color="orange">
              {t('testcases.editedBadge')}
            </Badge>
          )}
          <Badge size="xs" variant="light" color={doc.ext === 'csv' ? 'teal' : 'green'}>
            {doc.ext}
          </Badge>
          <Badge size="xs" variant="light" color="gray">
            {formatSize(doc.size)}
          </Badge>
          <Button
            size="compact-xs"
            variant={active ? 'filled' : 'light'}
            leftSection={<TbEye size={12} />}
            onClick={onOpen}
          >
            {t('testcases.open')}
          </Button>
          <Menu position="bottom-end" withArrow>
            <Menu.Target>
              <Button
                size="compact-xs"
                variant="light"
                color="gray"
                leftSection={<TbDownload size={12} />}
              >
                {t('testcases.download')}
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                component="a"
                href={downloadUrl(doc.path, 'source')}
                leftSection={<TbFileSpreadsheet size={14} />}
              >
                <Text size="xs">{t('testcases.downloadTemplate')}</Text>
                <Text size="xs" c="dimmed">
                  {doc.name}
                </Text>
              </Menu.Item>
              <Menu.Item
                component="a"
                href={downloadUrl(doc.path, 'result')}
                leftSection={<TbTable size={14} />}
              >
                <Text size="xs">{t('testcases.downloadResult')}</Text>
                <Text size="xs" c="dimmed">
                  {doc.edited
                    ? doc.name.replace(/\.(xlsx|csv)$/i, '.result.xlsx')
                    : t('testcases.downloadResultEmpty')}
                </Text>
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>
    </Paper>
  );
}
