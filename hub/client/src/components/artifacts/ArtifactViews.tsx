import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  Group,
  Image,
  Loader,
  Modal,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  TbCamera,
  TbDownload,
  TbEye,
  TbFile,
  TbFileText,
  TbFolder,
  TbMovie,
  TbPlayerPlay,
  TbRoute,
  TbTrash,
} from 'react-icons/tb';
import { api } from '~/api/client';
import { EmptyState } from '~/components/EmptyState.js';
import { useT } from '~/i18n/index.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ArtifactFolder {
  name: string;
  path: string;
  totalSize?: number;
  fileCount?: number;
  children?: ArtifactNode[];
}

export interface ArtifactFile {
  name: string;
  path: string;
  size: number;
  mimeType: string;
  type: 'screenshot' | 'video' | 'trace' | 'log' | 'html' | 'json' | 'other';
}

export type ArtifactNode = ArtifactFolder | ArtifactFile;

export type FileType = 'screenshot' | 'video' | 'trace' | 'log';
export type ViewMode = 'grid' | 'list';

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function isFolder(node: ArtifactNode): node is ArtifactFolder {
  return 'children' in node && Array.isArray(node.children);
}

export function isFile(node: ArtifactNode): node is ArtifactFile {
  return 'size' in node && 'type' in node && !('children' in node);
}

export function hasFilesDeep(folder: ArtifactFolder): boolean {
  for (const child of folder.children ?? []) {
    if (isFile(child)) return true;
    if (isFolder(child) && hasFilesDeep(child)) return true;
  }
  return false;
}

export function formatSize(bytes?: number): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileTypeColor(type: string): string {
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

export function fileTypeIcon(type: string, size = 20) {
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

export function serveUrl(path: string): string {
  return `/api/artifacts/serve?path=${encodeURIComponent(path)}`;
}

/**
 * Enter/Space activation for `role="button"` containers (Card/Group) that hold
 * nested controls (checkbox, download/delete icons). Guarding on
 * `target === currentTarget` keeps keyboard activation to the container itself,
 * so activating a nested control does not also trigger navigation.
 */
export function handleActivateKey(action: () => void) {
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
export function ArtifactsEmpty() {
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
          leftSection={<TbPlayerPlay size={14} />}
          onClick={() => navigate({ to: '/run' })}
        >
          {t('history.startRun')}
        </Button>
      }
    />
  );
}

export function FolderCard({
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
      </Stack>
    </Card>
  );
}

export function FileCard({ node, onClick }: { node: ArtifactFile; onClick: () => void }) {
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

export function FileRow({
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

export function FolderRow({
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

export function PreviewModal({
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
