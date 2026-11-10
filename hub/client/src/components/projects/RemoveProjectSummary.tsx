import type { ProjectSummary, ToolView } from '@hub/shared';
import { Code, Paper, SimpleGrid, Stack, Text } from '@mantine/core';
import { useT } from '~/i18n/index.js';

const LABEL_WIDTH = 96;

interface RemoveProjectSummaryProps {
  target: ProjectSummary;
  allProjects: readonly ProjectSummary[];
  tools: readonly ToolView[];
}

export function RemoveProjectSummary({ target, allProjects, tools }: RemoveProjectSummaryProps) {
  const t = useT();
  const toolTitle = tools.find((x) => x.id === target.tool)?.title ?? target.tool;
  const sameName = allProjects.filter((p) => p.name === target.name && p.tool !== target.tool);
  const rows = [
    { label: t('projects.removeTool'), value: toolTitle },
    { label: t('run.type'), value: target.type },
    { label: t('run.project'), value: target.name },
  ];

  return (
    <Stack gap="sm">
      <Text size="sm">{t('projects.removeDesc')}</Text>
      <Paper p="sm" bg="var(--mantine-color-default-hover)">
        <SimpleGrid
          cols={2}
          spacing="sm"
          verticalSpacing={6}
          style={{ gridTemplateColumns: `${LABEL_WIDTH}px minmax(0, 1fr)` }}
        >
          {rows.map((row) => [
            <Text key={`${row.label}-l`} size="xs" c="dimmed">
              {row.label}
            </Text>,
            <Text key={`${row.label}-v`} size="sm" fw={500}>
              {row.value}
            </Text>,
          ])}
          {target.path && [
            <Text key="path-l" size="xs" c="dimmed">
              {t('projects.removeFolder')}
            </Text>,
            <Code key="path-v" style={{ overflowWrap: 'anywhere', whiteSpace: 'normal' }}>
              {target.path}
            </Code>,
          ]}
        </SimpleGrid>
      </Paper>
      {sameName.length > 0 && (
        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            {t('projects.removeKept')}
          </Text>
          {sameName.map((p) => (
            <Text key={`${p.tool}/${p.type}/${p.name}`} size="xs" ff="monospace" c="green.4">
              {p.tool}/{p.type}/{p.name}
            </Text>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
