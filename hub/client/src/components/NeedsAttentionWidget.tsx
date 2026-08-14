import type { FlakyReport, ProjectSummary, RunRecord } from '@hub/shared';
import { Button, Group, Paper, ScrollArea, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { TbAlertCircle, TbAlertTriangle, TbCircleCheck } from 'react-icons/tb';
import { api } from '~/api/client';
import { useT } from '~/i18n/index.js';

interface AttentionItem {
  severity: 'red' | 'yellow';
  icon: React.ReactNode;
  message: string;
  action: string;
  page: string;
}

export function NeedsAttentionWidget({ onNavigate }: { onNavigate: (page: string) => void }) {
  const t = useT();
  const projects = useQuery<ProjectSummary[]>({
    queryKey: ['projects'],
    queryFn: () => api.get('/api/projects'),
  });

  const history = useQuery<RunRecord[]>({
    queryKey: ['runs-history'],
    queryFn: () => api.get('/api/runs/history'),
  });

  const flaky = useQuery<FlakyReport>({
    queryKey: ['flaky'],
    queryFn: () => api.get('/api/flaky'),
  });

  const items: AttentionItem[] = [];

  // Check projects with missing env keys
  const missingEnvProjects = (projects.data ?? []).filter((p) => p.missingEnvKeys.length > 0);
  if (missingEnvProjects.length > 0) {
    items.push({
      severity: 'red',
      icon: <TbAlertCircle size={16} />,
      message: `${missingEnvProjects.length} ${t('needsAttention.missingEnv')}`,
      action: t('needsAttention.fix'),
      page: 'env-profiles',
    });
  }

  // Check recent failures (last 24h)
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recentFailures = (history.data ?? []).filter(
    (r) => r.status === 'failed' && r.endedAt && new Date(r.endedAt).getTime() > oneDayAgo,
  );
  if (recentFailures.length > 0) {
    items.push({
      severity: 'yellow',
      icon: <TbAlertTriangle size={16} />,
      message: `${recentFailures.length} ${t('needsAttention.recentFailures')}`,
      action: t('needsAttention.view'),
      page: 'history',
    });
  }

  // Check flaky tests
  const flakyCount = flaky.data?.flakyTests?.length ?? 0;
  if (flakyCount > 0) {
    items.push({
      severity: 'yellow',
      icon: <TbAlertTriangle size={16} />,
      message: `${flakyCount} ${t('needsAttention.flaky')}`,
      action: t('needsAttention.review'),
      page: 'insights',
    });
  }

  if (items.length === 0) {
    return (
      <Paper p="md" withBorder>
        <Group gap="sm">
          <TbCircleCheck size={20} color="var(--mantine-color-green-6)" />
          <Stack gap={0}>
            <Title order={5}>{t('dashboard.allGood')}</Title>
            <Text size="xs" c="dimmed">
              {t('dashboard.allGoodDesc')}
            </Text>
          </Stack>
        </Group>
      </Paper>
    );
  }

  return (
    <Paper p="md" withBorder>
      <Title order={5} mb="sm">
        {t('dashboard.needsAttention')}
      </Title>
      {/* Autosize + cap, not a fixed height: with three items a fixed 35vh left
          most of this card empty. */}
      <ScrollArea.Autosize mah="35vh">
        <Stack gap="xs">
          {/* Neutral surface + a left accent, not a tinted Alert. Three filled
              red/amber bars made every item shout equally, so severity stopped
              ranking anything — the icon and the accent carry it now, and the
              action button is the only thing competing for the click. */}
          {items.slice(0, 5).map((item) => (
            <Paper
              key={item.message}
              p="xs"
              withBorder
              style={{
                borderLeftWidth: 3,
                borderLeftColor: `var(--mantine-color-${item.severity}-6)`,
              }}
            >
              <Group justify="space-between" wrap="nowrap" gap="xs">
                <Group gap={8} wrap="nowrap" c={`${item.severity}.4`}>
                  {item.icon}
                  <Text size="sm" c="var(--mantine-color-text)">
                    {item.message}
                  </Text>
                </Group>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="gray"
                  onClick={() => onNavigate(item.page)}
                >
                  {item.action}
                </Button>
              </Group>
            </Paper>
          ))}
        </Stack>
      </ScrollArea.Autosize>
    </Paper>
  );
}
