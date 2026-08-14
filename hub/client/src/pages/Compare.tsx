import type { CompareCategory, CompareSide, RunCompareResult } from '@hub/shared';
import {
  Badge,
  Card,
  Group,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { TbAlertTriangle, TbGitCompare } from 'react-icons/tb';
import { api } from '~/api/client.js';
import { EmptyState } from '~/components/EmptyState.js';
import { InlineAlert } from '~/components/InlineAlert.js';
import { PageHeader } from '~/components/PageHeader.js';
import { ListSkeleton } from '~/components/Skeletons.js';
import type { TranslationKey } from '~/i18n/index.js';
import { useT } from '~/i18n/index.js';
import { compareRoute } from '~/router.js';
import { formatAbsolute } from '~/utils/datetime.js';

const CATEGORY_ORDER: CompareCategory[] = [
  'newlyFailed',
  'stillFailing',
  'fixed',
  'added',
  'removed',
  'stillPassing',
];

const CATEGORY_COLOR: Record<CompareCategory, string> = {
  newlyFailed: 'red',
  stillFailing: 'orange',
  fixed: 'green',
  added: 'blue',
  removed: 'gray',
  stillPassing: 'teal',
};

const CATEGORY_LABEL: Record<CompareCategory, TranslationKey> = {
  newlyFailed: 'compare.newlyFailed',
  stillFailing: 'compare.stillFailing',
  fixed: 'compare.fixed',
  added: 'compare.added',
  removed: 'compare.removed',
  stillPassing: 'compare.stillPassing',
};

function statusColor(status?: string): string {
  if (status === 'passed') return 'green';
  if (status === 'failed') return 'red';
  return 'gray';
}

function SideCard({ label, side }: { label: string; side: CompareSide }) {
  return (
    <Card withBorder padding="sm">
      <Stack gap={4}>
        <Text size="xs" c="dimmed">
          {label}
        </Text>
        <Text size="sm" fw={600} truncate>
          {side.project}
        </Text>
        <Text size="xs" c="dimmed">
          {formatAbsolute(side.startedAt)}
        </Text>
        <Group gap="xs">
          <Badge size="xs" color="green" variant="light">
            {side.passed} passed
          </Badge>
          <Badge size="xs" color="red" variant="light">
            {side.failed} failed
          </Badge>
          <Badge size="xs" color="gray" variant="light">
            {side.total} total
          </Badge>
        </Group>
      </Stack>
    </Card>
  );
}

export function ComparePage() {
  const t = useT();
  const { a, b } = compareRoute.useSearch();
  const query = useQuery<RunCompareResult>({
    queryKey: ['compare', a, b],
    queryFn: () => api.get(`/api/runs/compare?a=${a}&b=${b}`),
    enabled: !!a && !!b,
  });

  const header = <PageHeader title={t('compare.title')} description={t('compare.desc')} />;
  const empty = (message: string) => (
    <EmptyState
      icon={<TbGitCompare size={48} color="var(--mantine-color-dimmed)" />}
      description={message}
    />
  );

  if (!a || !b) {
    return (
      <Stack gap="md">
        {header}
        {empty(t('compare.selectTwo'))}
      </Stack>
    );
  }
  if (query.isLoading) return <ListSkeleton />;
  const data = query.data;
  if (!data) {
    return (
      <Stack gap="md">
        {header}
        {empty(t('compare.noRuns'))}
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      {header}

      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
        <SideCard label={t('compare.baseline')} side={data.a} />
        <SideCard label={t('compare.target')} side={data.b} />
      </SimpleGrid>

      {data.unavailable && (
        <InlineAlert icon={<TbAlertTriangle size={16} />} message={t('compare.unavailable')} />
      )}

      <Group gap="xs">
        {CATEGORY_ORDER.map((cat) => (
          <Badge key={cat} size="sm" variant="light" color={CATEGORY_COLOR[cat]}>
            {t(CATEGORY_LABEL[cat])}: {data.counts[cat]}
          </Badge>
        ))}
      </Group>

      {data.rows.length === 0 ? (
        empty(t('compare.noRuns'))
      ) : (
        <Paper withBorder radius="md">
          <ScrollArea.Autosize mah="60vh">
            <Table striped highlightOnHover verticalSpacing="xs" stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('compare.change')}</Table.Th>
                  <Table.Th>{t('compare.test')}</Table.Th>
                  <Table.Th>A</Table.Th>
                  <Table.Th>B</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.rows.map((row) => (
                  <Table.Tr key={row.key}>
                    <Table.Td>
                      <Badge size="xs" variant="light" color={CATEGORY_COLOR[row.category]}>
                        {t(CATEGORY_LABEL[row.category])}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Stack gap={0}>
                        <Text size="xs" truncate maw={440}>
                          {row.title}
                        </Text>
                        {row.file && (
                          <Text size="xs" c="dimmed" ff="monospace" truncate maw={440}>
                            {row.file}
                          </Text>
                        )}
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      {row.a ? (
                        <Badge size="xs" variant="light" color={statusColor(row.a)}>
                          {row.a}
                        </Badge>
                      ) : (
                        <Text size="xs" c="dimmed">
                          —
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {row.b ? (
                        <Badge size="xs" variant="light" color={statusColor(row.b)}>
                          {row.b}
                        </Badge>
                      ) : (
                        <Text size="xs" c="dimmed">
                          —
                        </Text>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>
        </Paper>
      )}
    </Stack>
  );
}
