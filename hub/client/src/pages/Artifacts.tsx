import {
  ActionIcon,
  Anchor,
  Badge,
  Breadcrumbs,
  Button,
  Checkbox,
  Group,
  Paper,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  TbArrowLeft,
  TbCamera,
  TbFileText,
  TbGridDots,
  TbList,
  TbMovie,
  TbRoute,
  TbTrash,
} from 'react-icons/tb';
import { api } from '~/api/client';
import {
  type ArtifactFile,
  type ArtifactFolder,
  ArtifactsEmpty,
  FileCard,
  FileRow,
  type FileType,
  FolderCard,
  FolderRow,
  hasFilesDeep,
  isFile,
  isFolder,
  PreviewModal,
  type ViewMode,
} from '~/components/artifacts/ArtifactViews.js';
import { confirmDialog } from '~/components/confirmDialog';
import { ErrorState } from '~/components/ErrorState.js';
import { PageHeader } from '~/components/PageHeader.js';
import { GridSkeleton } from '~/components/Skeletons.js';
import { toast } from '~/components/Toast';
import { useT } from '~/i18n/index.js';
import { usePreferences } from '~/stores/hub.js';

// ─── Main Page ───────────────────────────────────────────────────────────────

export function ArtifactsPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [currentPath, setCurrentPath] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [typeFilter, setTypeFilter] = useState<FileType | null>(null);
  const [previewFile, setPreviewFile] = useState<ArtifactFile | null>(null);
  const [previewOpened, { open: openPreview, close: closePreview }] = useDisclosure(false);
  const hideEmpty = usePreferences((s) => s.hideEmptyArtifactFolders);
  const setHideEmpty = usePreferences((s) => s.setHideEmptyArtifactFolders);

  const tree = useQuery<ArtifactFolder>({
    queryKey: ['artifacts'],
    queryFn: () => api.get('/api/artifacts'),
  });

  const deleteMutation = useMutation({
    mutationFn: (artifactPath: string) =>
      api.delete(`/api/artifacts?path=${encodeURIComponent(artifactPath)}`),
    onSuccess: () => {
      toast.success(t('artifacts.deleted'));
      queryClient.invalidateQueries({ queryKey: ['artifacts'] });
    },
    onError: () => toast.error(t('artifacts.deleteFailed')),
  });

  const handleDelete = useCallback(
    async (name: string, artifactPath: string, isFolder: boolean) => {
      const ok = await confirmDialog({
        title: t(isFolder ? 'artifacts.deleteFolderTitle' : 'artifacts.deleteFileTitle'),
        message: `"${name}" — ${t(
          isFolder ? 'artifacts.deleteConfirmFolder' : 'artifacts.deleteConfirmFile',
        )}`,
        confirmLabel: t('common.delete'),
        danger: true,
      });
      if (ok) deleteMutation.mutate(artifactPath);
    },
    [deleteMutation, t],
  );

  // Multiselect state
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  const toggleSelect = useCallback((artifactPath: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(artifactPath)) next.delete(artifactPath);
      else next.add(artifactPath);
      return next;
    });
  }, []);

  const bulkDeleteMutation = useMutation({
    mutationFn: async (paths: string[]) => {
      for (const p of paths) {
        await api.delete(`/api/artifacts?path=${encodeURIComponent(p)}`);
      }
    },
    onSuccess: () => {
      toast.success(t('artifacts.deleted'));
      setSelectedPaths(new Set());
      queryClient.invalidateQueries({ queryKey: ['artifacts'] });
    },
    onError: () => toast.error(t('artifacts.deleteSomeFailed')),
  });

  const handleBulkDelete = useCallback(async () => {
    const paths = [...selectedPaths];
    if (paths.length === 0) return;
    const ok = await confirmDialog({
      title: `Delete ${paths.length} item(s)?`,
      message:
        'This will permanently delete all selected files and folders. This action cannot be undone.',
      confirmLabel: `Delete ${paths.length}`,
      danger: true,
    });
    if (ok) bulkDeleteMutation.mutate(paths);
  }, [selectedPaths, bulkDeleteMutation]);

  // Clear selection when navigating
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on path change
  useEffect(() => {
    setSelectedPaths(new Set());
  }, [currentPath]);

  // Navigate into the tree based on currentPath
  const currentFolder = useMemo((): ArtifactFolder | null => {
    if (!tree.data) return null;
    let folder: ArtifactFolder = tree.data;
    for (const segment of currentPath) {
      const child = folder.children?.find((c) => c.name === segment && isFolder(c));
      if (!child || !isFolder(child)) return null;
      folder = child;
    }
    return folder;
  }, [tree.data, currentPath]);

  // Separate folders and files, apply type filter
  const { folders, files } = useMemo(() => {
    if (!currentFolder?.children) return { folders: [], files: [] };
    const f: ArtifactFolder[] = [];
    const fi: ArtifactFile[] = [];
    for (const child of currentFolder.children) {
      if (isFolder(child)) {
        if (!hideEmpty || hasFilesDeep(child)) f.push(child);
      } else if (isFile(child)) {
        if (!typeFilter || child.type === typeFilter) fi.push(child);
      }
    }
    return { folders: f, files: fi };
  }, [currentFolder, typeFilter, hideEmpty]);

  const navigateInto = useCallback((folderName: string) => {
    setCurrentPath((prev) => [...prev, folderName]);
  }, []);

  const navigateTo = useCallback((index: number) => {
    setCurrentPath((prev) => prev.slice(0, index));
  }, []);

  const goBack = useCallback(() => {
    setCurrentPath((prev) => prev.slice(0, -1));
  }, []);

  const handleFileClick = useCallback(
    (file: ArtifactFile) => {
      setPreviewFile(file);
      openPreview();
    },
    [openPreview],
  );

  // Breadcrumb items
  const breadcrumbItems = useMemo(() => {
    const items = [
      <Anchor key="root" size="sm" onClick={() => navigateTo(0)} style={{ cursor: 'pointer' }}>
        {t('nav.artifacts')}
      </Anchor>,
    ];
    for (let i = 0; i < currentPath.length; i++) {
      const idx = i + 1;
      items.push(
        <Anchor key={idx} size="sm" onClick={() => navigateTo(idx)} style={{ cursor: 'pointer' }}>
          {currentPath[i]}
        </Anchor>,
      );
    }
    return items;
  }, [currentPath, navigateTo, t]);

  // Filter buttons
  const filterTypes: { value: FileType; label: string; icon: React.ReactNode }[] = [
    { value: 'screenshot', label: t('artifacts.filterScreenshots'), icon: <TbCamera size={14} /> },
    { value: 'video', label: t('artifacts.filterVideos'), icon: <TbMovie size={14} /> },
    { value: 'trace', label: t('artifacts.filterTraces'), icon: <TbRoute size={14} /> },
    { value: 'log', label: t('artifacts.filterLogs'), icon: <TbFileText size={14} /> },
  ];

  if (tree.isError) {
    return <ErrorState onRetry={() => tree.refetch()} />;
  }
  if (tree.isLoading) {
    return <GridSkeleton count={12} />;
  }

  return (
    <Stack gap="md">
      {/* Header */}
      <PageHeader
        title={t('nav.artifacts')}
        description={t('nav.artifacts.desc')}
        actions={
          <Group gap="md" wrap="nowrap">
            <Switch
              size="sm"
              checked={hideEmpty}
              onChange={(e) => setHideEmpty(e.currentTarget.checked)}
              label={t('artifacts.hideEmpty')}
            />
            <SegmentedControl
              size="xs"
              value={viewMode}
              onChange={(v) => setViewMode(v as ViewMode)}
              data={[
                { value: 'grid', label: <TbGridDots size={16} /> },
                { value: 'list', label: <TbList size={16} /> },
              ]}
            />
          </Group>
        }
      />

      {/* Breadcrumb + Back */}
      <Paper withBorder p="sm" radius="md">
        <Group gap="sm">
          {currentPath.length > 0 && (
            <Tooltip label={t('artifacts.goBack')}>
              <ActionIcon variant="subtle" size="sm" onClick={goBack}>
                <TbArrowLeft size={16} />
              </ActionIcon>
            </Tooltip>
          )}
          <Breadcrumbs separator="/">{breadcrumbItems}</Breadcrumbs>
        </Group>
      </Paper>

      {/* Type filters */}
      <Group gap="xs">
        <Button
          size="xs"
          variant={typeFilter === null ? 'filled' : 'light'}
          color="gray"
          onClick={() => setTypeFilter(null)}
        >
          {t('common.all')}
        </Button>
        {filterTypes.map((ft) => (
          <Button
            key={ft.value}
            size="xs"
            variant={typeFilter === ft.value ? 'filled' : 'light'}
            leftSection={ft.icon}
            onClick={() => setTypeFilter(typeFilter === ft.value ? null : ft.value)}
          >
            {ft.label}
          </Button>
        ))}
      </Group>

      {/* Selection bar */}
      {(folders.length > 0 || files.length > 0) && (
        <Group gap="sm">
          <Checkbox
            size="xs"
            checked={
              selectedPaths.size > 0 &&
              [...folders.map((f) => f.path), ...files.map((f) => f.path)].every((p) =>
                selectedPaths.has(p),
              )
            }
            indeterminate={
              selectedPaths.size > 0 &&
              ![...folders.map((f) => f.path), ...files.map((f) => f.path)].every((p) =>
                selectedPaths.has(p),
              )
            }
            onChange={() => {
              const allPaths = [...folders.map((f) => f.path), ...files.map((f) => f.path)];
              const allSelected = allPaths.every((p) => selectedPaths.has(p));
              setSelectedPaths(allSelected ? new Set() : new Set(allPaths));
            }}
            label={
              <Text size="xs" c="dimmed">
                {t('common.selectAll')}
              </Text>
            }
          />
          {selectedPaths.size > 0 && (
            <>
              <Badge size="sm" variant="light">
                {selectedPaths.size} {t('artifacts.selectedCount')}
              </Badge>
              <Button
                size="compact-xs"
                color="red"
                variant="subtle"
                leftSection={<TbTrash size={12} />}
                onClick={handleBulkDelete}
                loading={bulkDeleteMutation.isPending}
              >
                {t('artifacts.deleteSelected')}
              </Button>
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                onClick={() => setSelectedPaths(new Set())}
              >
                {t('common.clear')}
              </Button>
            </>
          )}
        </Group>
      )}

      {/* Content */}
      {!currentFolder || (folders.length === 0 && files.length === 0) ? (
        <ArtifactsEmpty />
      ) : viewMode === 'grid' ? (
        <SimpleGrid cols={{ base: 2, sm: 3, md: 4, lg: 5 }} spacing="md">
          {folders.map((folder) => (
            <FolderCard
              key={folder.path}
              node={folder}
              onClick={() => navigateInto(folder.name)}
              onDelete={() => handleDelete(folder.name, folder.path, true)}
              selected={selectedPaths.has(folder.path)}
              onToggleSelect={() => toggleSelect(folder.path)}
            />
          ))}
          {files.map((file) => (
            <FileCard key={file.path} node={file} onClick={() => handleFileClick(file)} />
          ))}
        </SimpleGrid>
      ) : (
        <Paper withBorder radius="md">
          <ScrollArea.Autosize mah="65vh">
            {folders.map((folder) => (
              <FolderRow
                key={folder.path}
                node={folder}
                onClick={() => navigateInto(folder.name)}
                onDelete={() => handleDelete(folder.name, folder.path, true)}
                selected={selectedPaths.has(folder.path)}
                onToggleSelect={() => toggleSelect(folder.path)}
              />
            ))}
            {files.map((file) => (
              <FileRow
                key={file.path}
                node={file}
                onClick={() => handleFileClick(file)}
                onDelete={() => handleDelete(file.name, file.path, false)}
                selected={selectedPaths.has(file.path)}
                onToggleSelect={() => toggleSelect(file.path)}
              />
            ))}
          </ScrollArea.Autosize>
        </Paper>
      )}

      {/* Preview Modal */}
      <PreviewModal file={previewFile} opened={previewOpened} onClose={closePreview} />
    </Stack>
  );
}
