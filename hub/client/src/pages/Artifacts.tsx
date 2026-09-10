import {
  ActionIcon,
  Anchor,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  Checkbox,
  Code,
  Group,
  Image,
  Loader,
  Modal,
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
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  TbArrowLeft,
  TbCamera,
  TbDownload,
  TbEye,
  TbFile,
  TbFileText,
  TbFolder,
  TbGridDots,
  TbList,
  TbMovie,
  TbPlayerPlay,
  TbRoute,
  TbTrash,
} from 'react-icons/tb';
import { api } from '~/api/client';
import { confirmDialog } from '~/components/confirmDialog';
import { EmptyState } from '~/components/EmptyState.js';
import { ErrorState } from '~/components/ErrorState.js';
import { PageHeader } from '~/components/PageHeader.js';
import { GridSkeleton } from '~/components/Skeletons.js';
import { toast } from '~/components/Toast';
import { useT } from '~/i18n/index.js';
import { usePreferences } from '~/stores/hub.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ArtifactFolder {
  name: string;
  path: string;
  totalSize?: number;
  fileCount?: number;
  children?: ArtifactNode[];
}

interface ArtifactFile {
  name: string;
  path: string;
  size: number;
  mimeType: string;
  type: 'screenshot' | 'video' | 'trace' | 'log' | 'html' | 'json' | 'other';
}

type ArtifactNode = ArtifactFolder | ArtifactFile;

type FileType = 'screenshot' | 'video' | 'trace' | 'log';
type ViewMode = 'grid' | 'list';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isFolder(node: ArtifactNode): node is ArtifactFolder {
  return 'children' in node && Array.isArray(node.children);
}

function isFile(node: ArtifactNode): node is ArtifactFile {
  return 'size' in node && 'type' in node && !('children' in node);
}

function hasFilesDeep(folder: ArtifactFolder): boolean {
  for (const child of folder.children ?? []) {
    if (isFile(child)) return true;
    if (isFolder(child) && hasFilesDeep(child)) return true;
  }
  return false;
}

function formatSize(bytes?: number): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileTypeColor(type: string): string {
  switch (type) {
    case 'screenshot':
      return 'teal';
    case 'video':
      return 'violet';
    case 'trace':
      return 'orange';
    case 'log':
      return 'gray';
    case 'html':
      return 'blue';
    case 'json':
      return 'cyan';
    default:
      return 'dark';
  }
}

function fileTypeIcon(type: string, size = 20) {
  switch (type) {
    case 'screenshot':
      return <TbCamera size={size} color="var(--mantine-color-teal-6)" />;
    case 'video':
      return <TbMovie size={size} color="var(--mantine-color-violet-6)" />;
    case 'trace':
      return <TbRoute size={size} color="var(--mantine-color-orange-6)" />;
    case 'log':
      return <TbFileText size={size} color="var(--mantine-color-gray-6)" />;
    default:
      return <TbFile size={size} color="var(--mantine-color-blue-6)" />;
  }
}

function serveUrl(path: string): string {
  return `/api/artifacts/serve?path=${encodeURIComponent(path)}`;
}

/**
 * Enter/Space activation for `role="button"` containers (Card/Group) that hold
 * nested controls (checkbox, download/delete icons). Guarding on
 * `target === currentTarget` keeps keyboard activation to the container itself,
 * so activating a nested control does not also trigger navigation.
 */
function handleActivateKey(action: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      action();
    }
  };
}

// ─── Components ──────────────────────────────────────────────────────────────

/** First-run state: explains what lands here and offers the one action that fills it. */
function ArtifactsEmpty() {
  const t = useT();
  const navigate = useNavigate();
  return (
    <EmptyState
      icon={<TbFolder size={48} color="var(--mantine-color-dimmed)" />}
      title={t('artifacts.noArtifacts')}
      description={t('artifacts.noArtifactsDesc')}
      action={
        <Button
          size="xs"
          color="green"
          leftSection={<TbPlayerPlay size={14} />}
          onClick={() => navigate({ to: '/run' })}
        >
          {t('history.startRun')}
        </Button>
      }
    />
  );
}

function FolderCard({
  node,
  onClick,
  onDelete,
  selected,
  onToggleSelect,
}: {
  node: ArtifactFolder;
  onClick: () => void;
  onDelete?: () => void;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const t = useT();
  return (
    <Card
      withBorder
      padding="lg"
      radius="md"
      role="button"
      tabIndex={0}
      aria-label={`Open folder ${node.name}`}
      onClick={onClick}
      onKeyDown={handleActivateKey(onClick)}
      style={{
        cursor: 'pointer',
        transition: 'box-shadow 150ms',
        position: 'relative',
        outline: selected ? '2px solid var(--mantine-color-brand-5)' : undefined,
      }}
      className="artifact-card"
    >
      {onToggleSelect && (
        <Checkbox
          size="xs"
          checked={selected}
          onChange={() => onToggleSelect()}
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          style={{ position: 'absolute', top: 8, right: 8 }}
        />
      )}
      <Stack gap="sm" align="center">
        <TbFolder size={36} color="var(--mantine-color-yellow-6)" />
        <Text fw={500} size="sm" ta="center" lineClamp={2}>
          {node.name}
        </Text>
        <Group gap="xs">
          {node.fileCount != null && (
            <Badge size="xs" variant="light" color="blue">
              {node.fileCount} files
            </Badge>
          )}
          {node.totalSize != null && (
            <Badge size="xs" variant="light" color="gray">
              {formatSize(node.totalSize)}
            </Badge>
          )}
        </Group>
        <Group gap="xs">
          <Tooltip label={t('artifacts.downloadZip')}>
            <ActionIcon
              variant="light"
              size="sm"
              component="a"
              href={`/api/artifacts/download-zip?path=${encodeURIComponent(node.path)}`}
              target="_blank"
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
            >
              <TbDownload size={14} />
            </ActionIcon>
          </Tooltip>
          {onDelete && (
            <Tooltip label={t('artifacts.deleteFolder')}>
              <ActionIcon
                variant="light"
                color="red"
                size="sm"
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  onDelete();
                }}
              >
                <TbTrash size={14} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      </Stack>
    </Card>
  );
}

function FileCard({ node, onClick }: { node: ArtifactFile; onClick: () => void }) {
  const t = useT();
  return (
    <Card
      withBorder
      padding="lg"
      radius="md"
      style={{ cursor: 'pointer' }}
      className="artifact-card"
    >
      <Stack gap="sm" align="center">
        {fileTypeIcon(node.type, 32)}
        <Text fw={500} size="sm" ta="center" lineClamp={2}>
          {node.name}
        </Text>
        <Group gap="xs">
          <Badge size="xs" variant="light" color={fileTypeColor(node.type)}>
            {node.type}
          </Badge>
          <Badge size="xs" variant="light" color="gray">
            {formatSize(node.size)}
          </Badge>
        </Group>
        <Group gap="xs">
          <Tooltip label={t('artifacts.preview')}>
            <ActionIcon variant="light" size="sm" onClick={onClick}>
              <TbEye size={14} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t('artifacts.download')}>
            <ActionIcon
              variant="light"
              size="sm"
              component="a"
              href={serveUrl(node.path)}
              target="_blank"
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
            >
              <TbDownload size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Stack>
    </Card>
  );
}

function FileRow({
  node,
  onClick,
  onDelete,
  selected,
  onToggleSelect,
}: {
  node: ArtifactFile;
  onClick: () => void;
  onDelete?: () => void;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const t = useT();
  return (
    <Group
      justify="space-between"
      px="sm"
      py="xs"
      role="button"
      tabIndex={0}
      aria-label={`${t('artifacts.preview')} ${node.name}`}
      style={{
        borderBottom: '1px solid var(--mantine-color-default-border)',
        cursor: 'pointer',
        background: selected ? 'var(--mantine-color-brand-light)' : undefined,
      }}
      onClick={onClick}
      onKeyDown={handleActivateKey(onClick)}
    >
      <Group gap="sm">
        {onToggleSelect && (
          <Checkbox
            size="xs"
            checked={selected}
            onChange={() => onToggleSelect()}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          />
        )}
        {fileTypeIcon(node.type, 16)}
        <Text size="sm">{node.name}</Text>
        <Badge size="xs" variant="light" color={fileTypeColor(node.type)}>
          {node.type}
        </Badge>
      </Group>
      <Group gap="sm">
        <Text size="xs" c="dimmed">
          {formatSize(node.size)}
        </Text>
        <Tooltip label={t('artifacts.download')}>
          <ActionIcon
            variant="subtle"
            size="sm"
            component="a"
            href={serveUrl(node.path)}
            target="_blank"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            <TbDownload size={14} />
          </ActionIcon>
        </Tooltip>
        {onDelete && (
          <Tooltip label={t('artifacts.deleteFile')}>
            <ActionIcon
              variant="subtle"
              color="red"
              size="sm"
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              <TbTrash size={14} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
    </Group>
  );
}

function FolderRow({
  node,
  onClick,
  onDelete,
  selected,
  onToggleSelect,
}: {
  node: ArtifactFolder;
  onClick: () => void;
  onDelete?: () => void;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const t = useT();
  return (
    <Group
      justify="space-between"
      px="sm"
      py="xs"
      role="button"
      tabIndex={0}
      aria-label={`Open folder ${node.name}`}
      style={{
        borderBottom: '1px solid var(--mantine-color-default-border)',
        cursor: 'pointer',
        background: selected ? 'var(--mantine-color-brand-light)' : undefined,
      }}
      onClick={onClick}
      onKeyDown={handleActivateKey(onClick)}
    >
      <Group gap="sm">
        {onToggleSelect && (
          <Checkbox
            size="xs"
            checked={selected}
            onChange={() => onToggleSelect()}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          />
        )}
        <TbFolder size={16} color="var(--mantine-color-yellow-6)" />
        <Text size="sm" fw={500}>
          {node.name}
        </Text>
      </Group>
      <Group gap="sm">
        {node.fileCount != null && (
          <Text size="xs" c="dimmed">
            {node.fileCount} files
          </Text>
        )}
        {node.totalSize != null && (
          <Text size="xs" c="dimmed">
            {formatSize(node.totalSize)}
          </Text>
        )}
        {onDelete && (
          <Tooltip label={t('artifacts.deleteFolder')}>
            <ActionIcon
              variant="subtle"
              color="red"
              size="sm"
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              <TbTrash size={14} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
    </Group>
  );
}

function PreviewModal({
  file,
  opened,
  onClose,
}: {
  file: ArtifactFile | null;
  opened: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const isImage = file?.type === 'screenshot';
  const isVideo = file?.type === 'video';
  const isText = !isImage && !isVideo;

  const textContent = useQuery<{ content: string; mimeType: string }>({
    queryKey: ['artifact-file', file?.path],
    queryFn: () => api.get(`/api/artifacts/file?path=${encodeURIComponent(file?.path ?? '')}`),
    enabled: opened && !!file && isText,
  });

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          {file && fileTypeIcon(file.type, 18)}
          <Text fw={500} size="sm">
            {file?.name}
          </Text>
        </Group>
      }
      size="xl"
      centered
    >
      {file && (
        <Stack gap="md">
          <Group justify="space-between">
            <Group gap="xs">
              <Badge size="sm" variant="light" color={fileTypeColor(file.type)}>
                {file.type}
              </Badge>
              <Badge size="sm" variant="light" color="gray">
                {formatSize(file.size)}
              </Badge>
            </Group>
            <Button
              size="xs"
              variant="light"
              leftSection={<TbDownload size={14} />}
              component="a"
              href={serveUrl(file.path)}
              target="_blank"
            >
              {t('artifacts.download')}
            </Button>
          </Group>

          {isImage && (
            <Image src={serveUrl(file.path)} alt={file.name} mah="55vh" fit="contain" radius="sm" />
          )}

          {isVideo && (
            // biome-ignore lint/a11y/useMediaCaption: artifact preview
            <video
              src={serveUrl(file.path)}
              controls
              style={{ maxHeight: '55vh', width: '100%', borderRadius: 8 }}
            />
          )}

          {isText && textContent.isLoading && (
            <Group gap="xs" justify="center" py="xl">
              <Loader size="sm" />
              <Text size="sm" c="dimmed">
                {t('artifacts.loadingContent')}
              </Text>
            </Group>
          )}

          {isText && textContent.data && (
            <ScrollArea.Autosize mah="55vh">
              <Code block style={{ fontSize: 12 }}>
                {textContent.data.content}
              </Code>
            </ScrollArea.Autosize>
          )}
        </Stack>
      )}
    </Modal>
  );
}

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
    { value: 'screenshot', label: 'Screenshots', icon: <TbCamera size={14} /> },
    { value: 'video', label: 'Videos', icon: <TbMovie size={14} /> },
    { value: 'trace', label: 'Traces', icon: <TbRoute size={14} /> },
    { value: 'log', label: 'Logs', icon: <TbFileText size={14} /> },
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
        title={t('artifacts.title')}
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
            color={fileTypeColor(ft.value)}
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
                variant="light"
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
