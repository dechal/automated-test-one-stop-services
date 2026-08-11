import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue, useDisclosure } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { TbCopy, TbDots, TbFolder, TbPlayerPlay, TbRoute, TbSearch } from 'react-icons/tb';
import { api } from '~/api/client.js';
import { toast } from '~/components/Toast.js';
import { useT } from '~/i18n/index.js';

export interface ArtifactGroup {
  name: string;
  traces: { name: string; path: string }[];
  videos: { name: string; path: string }[];
  /**
   * Readable identity of the test behind the folder, joined server-side from the
   * run's `results.json`. Absent for older runs that kept no parseable report —
   * the UI then falls back to `name`.
   */
  test?: {
    title: string;
    caseId?: string;
    status: 'passed' | 'failed';
    tags: string[];
    file?: string;
    line?: number;
  };
}

export interface ArtifactData {
  groups: ArtifactGroup[];
}

export interface ArtifactMenuProps {
  /** Absolute path to the report file (`.../html-results/index.html`). */
  reportPath: string;
}

/**
 * Modal dropdown that lists trace + video artifacts for a single report.
 * Extracted from `pages/Reports.tsx` (was ~260 inline lines) to keep that
 * file focused on the report table itself.
 */
export function ArtifactMenu({ reportPath }: ArtifactMenuProps) {
  const t = useT();
  const [artifactOpen, { open: openArtifacts, close: closeArtifacts }] = useDisclosure(false);
  const [videoOpen, { open: openVideo, close: closeVideo }] = useDisclosure(false);
  const [selectedVideo, setSelectedVideo] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [runningTraces, setRunningTraces] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);

  // Track every trace-status poll interval so they are all cleared on unmount.
  // Without this, closing the modal / navigating away while a trace is opening
  // leaves the 3s poll running forever and calling setState on an unmounted
  // component.
  const pollIntervals = useRef<Set<ReturnType<typeof setInterval>>>(new Set());
  useEffect(() => {
    const intervals = pollIntervals.current;
    return () => {
      for (const id of intervals) clearInterval(id);
      intervals.clear();
    };
  }, []);

  const artifacts = useQuery<ArtifactData>({
    queryKey: ['artifacts', reportPath],
    queryFn: () => api.post('/api/reports/artifacts', { path: reportPath }),
    enabled: artifactOpen,
  });

  // Default-open the groups that contain a trace (the high-value artifact you
  // usually open first); groups with only videos stay collapsed to keep the list
  // scannable. Seeded once per modal-open (via the ref) so the user can still
  // expand/collapse any group freely afterward, and it re-seeds on reopen.
  const seededExpand = useRef(false);
  useEffect(() => {
    if (!artifactOpen) {
      seededExpand.current = false;
      return;
    }
    if (seededExpand.current || !artifacts.data) return;
    seededExpand.current = true;
    setExpandedGroups(
      new Set(artifacts.data.groups.filter((g) => g.traces.length > 0).map((g) => g.name)),
    );
  }, [artifactOpen, artifacts.data]);

  function toggleGroup(name: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function pollTraceStatus(tracePath: string) {
    const stopTracking = (interval: ReturnType<typeof setInterval>) => {
      clearInterval(interval);
      pollIntervals.current.delete(interval);
      setRunningTraces((prev) => {
        const next = new Set(prev);
        next.delete(tracePath);
        return next;
      });
    };
    const interval = setInterval(async () => {
      try {
        const res = await api.post<{ running: boolean }>('/api/reports/trace/status', {
          path: tracePath,
        });
        if (!res.running) stopTracking(interval);
      } catch {
        stopTracking(interval);
      }
    }, 3000);
    pollIntervals.current.add(interval);
  }

  async function openTrace(tracePath: string) {
    try {
      setRunningTraces((prev) => new Set(prev).add(tracePath));
      await api.post('/api/reports/trace/open', { path: tracePath });
      pollTraceStatus(tracePath);
    } catch {
      setRunningTraces((prev) => {
        const next = new Set(prev);
        next.delete(tracePath);
        return next;
      });
      toast.error(t('artifactMenu.traceFailed'));
    }
  }

  async function closeTrace(tracePath: string) {
    try {
      await api.post('/api/reports/trace/close', { path: tracePath });
    } catch {
      // ignore — the viewer may already be gone
    }
    setRunningTraces((prev) => {
      const next = new Set(prev);
      next.delete(tracePath);
      return next;
    });
  }

  function handleVideoClick(videoPath: string) {
    setSelectedVideo(`/api/reports/artifact/serve?path=${encodeURIComponent(videoPath)}`);
    openVideo();
  }

  function handleOpen() {
    setExpandedGroups(new Set());
    openArtifacts();
  }

  // Artifact run-directory = parent of html-results folder.
  // reportPath: .../<time>/html-results/index.html → dir: .../<time>/
  const artifactDir = (() => {
    const norm = reportPath.replace(/\\/g, '/');
    const lastSep = norm.lastIndexOf('/');
    if (lastSep === -1) return reportPath;
    const htmlResultsDir = norm.slice(0, lastSep);
    const prevSep = htmlResultsDir.lastIndexOf('/');
    return prevSep === -1 ? htmlResultsDir : htmlResultsDir.slice(0, prevSep);
  })();

  function handleCopyDir() {
    navigator.clipboard.writeText(artifactDir);
    toast.success(t('artifactMenu.pathCopied'));
  }

  async function handleRevealDir() {
    try {
      await api.post('/api/system/reveal', { path: artifactDir });
    } catch (err) {
      toast.error((err as Error).message || 'Reveal failed');
    }
  }

  const totalArtifacts = (artifacts.data?.groups ?? []).reduce(
    (sum, g) => sum + g.traces.length + g.videos.length,
    0,
  );

  // Search across everything that identifies a test — case id, title, tags and
  // the raw folder name — so whichever of those the user remembers will find it.
  const needle = debouncedSearch.trim().toLowerCase();
  const visibleGroups = (artifacts.data?.groups ?? []).filter((group) => {
    if (!needle) return true;
    const haystack = [
      group.name,
      group.test?.caseId ?? '',
      group.test?.title ?? '',
      group.test?.file ?? '',
      ...(group.test?.tags ?? []),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
  const visibleArtifacts = visibleGroups.reduce(
    (sum, g) => sum + g.traces.length + g.videos.length,
    0,
  );

  return (
    <>
      <Tooltip label={t('artifactMenu.view')}>
        <ActionIcon variant="subtle" size="sm" onClick={handleOpen} aria-label={t('nav.artifacts')}>
          <TbDots size={14} />
        </ActionIcon>
      </Tooltip>

      <Modal
        opened={artifactOpen}
        onClose={closeArtifacts}
        title={
          <Group gap="xs" wrap="nowrap">
            <Text fw={600}>Test Artifacts</Text>
            <Tooltip label={artifactDir} withArrow>
              <Button
                size="compact-xs"
                variant="light"
                leftSection={<TbCopy size={12} />}
                onClick={handleCopyDir}
              >
                Copy directory
              </Button>
            </Tooltip>
            <Tooltip label={t('artifactMenu.reveal')} withArrow>
              <Button
                size="compact-xs"
                variant="light"
                color="gray"
                leftSection={<TbFolder size={12} />}
                onClick={handleRevealDir}
              >
                Reveal
              </Button>
            </Tooltip>
          </Group>
        }
        // Case id + Thai title + the on-disk folder name on one row need real
        // width; at `lg` (620px) the list scrolled sideways, hiding exactly the
        // text that makes a row identifiable. `maxWidth` keeps it inside a small
        // viewport — kept as a style rather than folded into `size`, because a
        // calc/min() expression there is not a size Mantine reliably resolves.
        size={1100}
        styles={{ content: { maxWidth: '92vw' } }}
        centered
        scrollAreaComponent={ScrollArea.Autosize}
      >
        {artifacts.isLoading && (
          <Text size="sm" c="dimmed">
            Loading artifacts...
          </Text>
        )}
        {artifacts.data && totalArtifacts === 0 && (
          <Text size="sm" c="dimmed">
            No traces or videos found for this report.
          </Text>
        )}
        {artifacts.data && totalArtifacts > 0 && (
          <Stack gap="xs">
            <TextInput
              size="xs"
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              placeholder={t('artifactMenu.searchPlaceholder')}
              leftSection={<TbSearch size={14} />}
              autoFocus
            />
            <Text size="xs" c="dimmed">
              {visibleArtifacts} artifact(s) in {visibleGroups.length} test(s)
              {needle ? ` — ${t('artifactMenu.filteredFrom')} ${artifacts.data.groups.length}` : ''}
            </Text>
            {visibleGroups.length === 0 && (
              <Text size="sm" c="dimmed">
                {t('artifactMenu.noMatch')}
              </Text>
            )}
            {visibleGroups.map((group) => {
              const isExpanded = expandedGroups.has(group.name);
              // The case is the heading; the folder stays visible underneath it so
              // the row still maps to what is on disk (and to Playwright's own
              // report), which a rename-style relabel would have broken.
              // The spec title already opens with `<CASE_ID>: `, so rendering the
              // id badge AND the raw title printed it twice and pushed every row
              // past the modal width. Show the id once, then the prose only.
              const caseId = group.test?.caseId;
              const rawTitle = group.test?.title;
              const heading = rawTitle
                ? caseId && rawTitle.startsWith(caseId)
                  ? rawTitle.slice(caseId.length).replace(/^\s*:\s*/, '')
                  : rawTitle
                : group.name === '_root'
                  ? 'Root'
                  : group.name;
              return (
                <Paper key={group.name} withBorder style={{ overflow: 'hidden' }}>
                  <Button
                    variant="subtle"
                    fullWidth
                    justify="space-between"
                    aria-expanded={isExpanded}
                    onClick={() => toggleGroup(group.name)}
                    h="auto"
                    py={6}
                    rightSection={
                      <Badge size="xs" color="gray" variant="light">
                        {group.traces.length + group.videos.length}
                      </Badge>
                    }
                    styles={{
                      inner: { justifyContent: 'space-between' },
                      // `minWidth: 0` lets the label shrink inside the flex row;
                      // without it the nowrap contents set a min-content width and
                      // the whole list overflows instead of wrapping.
                      label: { whiteSpace: 'normal', minWidth: 0, flex: 1 },
                    }}
                  >
                    <Stack gap={2} style={{ minWidth: 0, textAlign: 'left' }}>
                      <Group gap={6} wrap="wrap" style={{ minWidth: 0 }}>
                        {caseId && (
                          <Text size="xs" fw={700} ff="monospace" style={{ flexShrink: 0 }}>
                            {caseId}
                          </Text>
                        )}
                        {/* Wraps rather than truncates: a cut-off Thai title is
                            unidentifiable, and there is no hover text in a list
                            this long. */}
                        <Text size="xs" fw={500} style={{ minWidth: 0 }}>
                          {heading}
                        </Text>
                        {group.test?.status === 'failed' && (
                          <Badge size="xs" color="red" style={{ flexShrink: 0 }}>
                            {t('run.failed')}
                          </Badge>
                        )}
                      </Group>
                      <Text size="10px" c="dimmed" ff="monospace" truncate>
                        {group.name}
                      </Text>
                    </Stack>
                  </Button>
                  {isExpanded && (
                    <Stack gap={4} px="sm" pb="sm">
                      {group.traces.map((t) => (
                        <Group key={t.path} gap="xs" wrap="nowrap">
                          <TbRoute size={14} color="var(--mantine-color-violet-6)" />
                          <Text size="xs" truncate style={{ flex: 1 }}>
                            {t.name}
                          </Text>
                          {runningTraces.has(t.path) ? (
                            <Button
                              size="compact-xs"
                              variant="filled"
                              color="red"
                              onClick={() => closeTrace(t.path)}
                            >
                              Stop
                            </Button>
                          ) : (
                            <Button
                              size="compact-xs"
                              variant="light"
                              color="violet"
                              onClick={() => openTrace(t.path)}
                            >
                              Open
                            </Button>
                          )}
                        </Group>
                      ))}
                      {group.videos.map((v) => (
                        <Group key={v.path} gap="xs" wrap="nowrap">
                          <TbPlayerPlay size={14} color="var(--mantine-color-blue-6)" />
                          <Text size="xs" truncate style={{ flex: 1 }}>
                            {v.name}
                          </Text>
                          <Button
                            size="compact-xs"
                            variant="light"
                            color="blue"
                            onClick={() => handleVideoClick(v.path)}
                          >
                            Play
                          </Button>
                        </Group>
                      ))}
                    </Stack>
                  )}
                </Paper>
              );
            })}
          </Stack>
        )}
      </Modal>

      <Modal
        opened={videoOpen}
        onClose={closeVideo}
        title={t('artifactMenu.videoTitle')}
        size="lg"
        centered
      >
        {selectedVideo && (
          <video
            src={selectedVideo}
            controls
            autoPlay
            style={{ width: '100%', maxHeight: '70vh', borderRadius: 8 }}
          >
            <track kind="captions" />
          </video>
        )}
      </Modal>
    </>
  );
}
