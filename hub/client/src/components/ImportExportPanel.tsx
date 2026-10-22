import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  FileInput,
  Group,
  List,
  Paper,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Title,
} from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { TbAlertTriangle, TbCircleCheck, TbDownload, TbFileImport, TbUpload } from 'react-icons/tb';
import { api } from '~/api/client';
import { confirmDialog } from '~/components/confirmDialog';
import { toast } from '~/components/Toast';
import type { TranslationKey } from '~/i18n/en';
import { useT } from '~/i18n/index.js';

interface ImportResult {
  bookmarks?: number;
  schedules?: number;
  webhooks?: number;
  envProfiles?: number;
}

interface ParsedPayload {
  version?: string;
  exportedAt?: string;
  bookmarks?: unknown[];
  schedules?: unknown[];
  webhooks?: unknown[];
  envProfiles?: unknown[];
}

const EXPORT_ITEMS = [
  { key: 'bookmarks', labelKey: 'bookmark.title' },
  { key: 'schedules', labelKey: 'nav.schedules' },
  { key: 'webhooks', labelKey: 'webhooks.title' },
  { key: 'envProfiles', labelKey: 'nav.envProfiles' },
] as const satisfies readonly { key: string; labelKey: TranslationKey }[];

/** Localised label for one export/import bucket. */
function itemLabel(t: (key: TranslationKey) => string, key: string): string {
  const item = EXPORT_ITEMS.find((i) => i.key === key);
  return item ? t(item.labelKey) : key;
}

type ExportKey = (typeof EXPORT_ITEMS)[number]['key'];
const ALL_KEYS: ExportKey[] = EXPORT_ITEMS.map((i) => i.key);

/**
 * Read a JSON file and validate it is a hub export payload. Returns the parsed
 * payload or null on failure (with a toast). Used to power the import preview.
 */
async function parseImportFile(file: File): Promise<ParsedPayload | null> {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('File is not a valid hub export.');
    }
    const obj = parsed as ParsedPayload;
    // Sanity check: at least one known section must be present.
    const hasAnySection = ALL_KEYS.some((k) => Array.isArray(obj[k]));
    if (!hasAnySection) {
      throw new Error('No bookmarks, schedules, webhooks, or envProfiles found.');
    }
    return obj;
  } catch (err) {
    toast.error(`Invalid export file: ${(err as Error).message}`);
    return null;
  }
}

export function ImportExportPanel() {
  const t = useT();
  // Export state
  const [exportIncludes, setExportIncludes] = useState<ExportKey[]>([...ALL_KEYS]);

  // Import state
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<ParsedPayload | null>(null);
  const [mergeMode, setMergeMode] = useState(true);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  // Re-parse preview whenever the selected file changes.
  useEffect(() => {
    let cancelled = false;
    if (!importFile) {
      setImportPreview(null);
      setImportResult(null);
      return;
    }
    void parseImportFile(importFile).then((p) => {
      if (cancelled) return;
      setImportPreview(p);
      // Clear stale result from a previous import.
      setImportResult(null);
    });
    return () => {
      cancelled = true;
    };
  }, [importFile]);

  function toggleExportItem(key: ExportKey) {
    setExportIncludes((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }

  const allExportSelected = exportIncludes.length === ALL_KEYS.length;

  const exportMutation = useMutation({
    mutationFn: async () => {
      const params = exportIncludes.join(',');
      const data = await api.get<unknown>(`/api/export?include=${params}`);
      return data;
    },
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `hub-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(t('settings.exportDownloaded'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const importMutation = useMutation({
    mutationFn: async (payload: ParsedPayload) =>
      api.post<ImportResult>('/api/import', { ...payload, merge: mergeMode }),
    onSuccess: (data) => {
      setImportResult(data);
      setImportFile(null);
      setImportPreview(null);
      toast.success(t('settings.importComplete'));
    },
    onError: (err) => toast.error((err as Error).message),
  });

  async function handleImportClick() {
    if (!importPreview) return;
    if (!mergeMode) {
      const ok = await confirmDialog({
        title: t('settings.replaceConfirmTitle'),
        message:
          'Replace mode will overwrite all current bookmarks, schedules, webhooks, and environment profiles with the contents of this file. This cannot be undone.',
        confirmLabel: t('settings.replaceConfirmLabel'),
        danger: true,
      });
      if (!ok) return;
    }
    importMutation.mutate(importPreview);
  }

  return (
    <Paper p="md" withBorder>
      <Stack gap="md">
        <Title order={2} size="h5">
          {t('settings.importExport')}
        </Title>

        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
          {/* Export card */}
          <Card withBorder p="sm" radius="sm">
            <Stack gap="xs">
              <Group gap="xs" align="center">
                <TbDownload size={16} />
                <Text size="sm" fw={600}>
                  {t('common.export')}
                </Text>
              </Group>
              <Text size="xs" c="dimmed">
                {t('settings.exportDesc')}
              </Text>

              <Group justify="space-between" align="center">
                <Text size="xs" fw={500}>
                  {t('settings.exportInclude')}
                </Text>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  onClick={() => setExportIncludes(allExportSelected ? [] : [...ALL_KEYS])}
                >
                  {allExportSelected ? t('common.clearAll') : t('common.selectAll')}
                </Button>
              </Group>

              <Stack gap={4}>
                {EXPORT_ITEMS.map((item) => (
                  <Checkbox
                    key={item.key}
                    label={t(item.labelKey)}
                    size="xs"
                    checked={exportIncludes.includes(item.key)}
                    onChange={() => toggleExportItem(item.key)}
                  />
                ))}
              </Stack>

              <Button
                size="xs"
                leftSection={<TbDownload size={14} />}
                onClick={() => exportMutation.mutate()}
                loading={exportMutation.isPending}
                disabled={exportIncludes.length === 0}
                mt="auto"
              >
                {t('common.export')}
              </Button>
            </Stack>
          </Card>

          {/* Import card */}
          <Card withBorder p="sm" radius="sm">
            <Stack gap="xs">
              <Group gap="xs" align="center">
                <TbUpload size={16} />
                <Text size="sm" fw={600}>
                  {t('common.import')}
                </Text>
              </Group>
              <Text size="xs" c="dimmed">
                {t('settings.importDesc')}
              </Text>

              <FileInput
                size="xs"
                placeholder={t('settings.importSelectFile')}
                accept=".json,application/json"
                value={importFile}
                onChange={setImportFile}
                leftSection={<TbFileImport size={14} />}
                clearable
              />

              {/* Preview of file contents */}
              {importPreview && (
                <Card withBorder p="xs" radius="sm" bg="var(--mantine-color-default-hover)">
                  <Stack gap={4}>
                    <Group gap={6} align="center">
                      <TbCircleCheck size={14} color="var(--mantine-color-green-6)" />
                      <Text size="xs" fw={500}>
                        {t('settings.importPreview')}
                      </Text>
                      {importPreview.version && (
                        <Badge size="xs" variant="light">
                          v{importPreview.version}
                        </Badge>
                      )}
                    </Group>
                    <List size="xs" spacing={2} center>
                      {ALL_KEYS.map((k) => {
                        const arr = importPreview[k];
                        const count = Array.isArray(arr) ? arr.length : null;
                        if (count === null) return null;
                        return (
                          <List.Item key={k}>
                            <Text size="xs">
                              {itemLabel(t, k)}:{' '}
                              <Text span fw={600}>
                                {count}
                              </Text>
                            </Text>
                          </List.Item>
                        );
                      })}
                    </List>
                  </Stack>
                </Card>
              )}

              <Switch
                label={mergeMode ? t('settings.importMergeMode') : t('settings.importReplaceMode')}
                checked={mergeMode}
                onChange={(e) => setMergeMode(e.currentTarget.checked)}
                size="sm"
                color={mergeMode ? 'blue' : 'red'}
              />
              {!mergeMode && (
                <Group gap={6} align="center" wrap="nowrap">
                  <TbAlertTriangle size={14} color="var(--mantine-color-red-6)" />
                  <Text size="xs" c="red">
                    {t('settings.importReplaceWarn')}
                  </Text>
                </Group>
              )}

              <Button
                size="xs"
                color={mergeMode ? 'blue' : 'red'}
                leftSection={<TbUpload size={14} />}
                onClick={handleImportClick}
                loading={importMutation.isPending}
                disabled={!importPreview}
                mt="auto"
              >
                {mergeMode ? t('settings.importMergeBtn') : t('settings.importReplaceBtn')}
              </Button>

              {importResult && (
                <Alert color="green" variant="light" title={t('settings.importComplete')} p="xs">
                  <Stack gap={2}>
                    {ALL_KEYS.map((k) => {
                      const count = importResult[k];
                      if (count == null) return null;
                      return (
                        <Text key={k} size="xs">
                          {itemLabel(t, k)}: {count} {t('settings.imported')}
                        </Text>
                      );
                    })}
                  </Stack>
                </Alert>
              )}
            </Stack>
          </Card>
        </SimpleGrid>
      </Stack>
    </Paper>
  );
}
