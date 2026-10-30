import type { PerformanceType, ToolId, ToolView } from '@hub/shared';
import type { ComboboxData } from '@mantine/core';
import { ActionIcon, Badge, Group, Select, SimpleGrid, Stack, Text, Tooltip } from '@mantine/core';
import type { ComponentProps, ReactNode } from 'react';
import { TbSettings } from 'react-icons/tb';
import { SectionSelect } from '~/components/SectionSelect.js';
import { TagSelector } from '~/components/TagSelector.js';
import { useT } from '~/i18n/index.js';
import { ENV_CURRENT } from '~/utils/env-options.js';
import { toolSelectData } from '~/utils/tool-label.js';

type TagSelectorProps = ComponentProps<typeof TagSelector>;
type SectionSelectProps = ComponentProps<typeof SectionSelect>;

export interface RunTargetFieldsProps {
  isRunning: boolean;
  collapseToggle: ReactNode;
  typeAxis: boolean;
  sectionAxis: boolean;
  supportsTags: boolean;
  tools: readonly ToolView[];
  tool: ToolId;
  setTool: (value: ToolId) => void;
  type: string;
  setType: (value: string) => void;
  typesData: string[] | undefined;
  project: string;
  setProject: (value: string) => void;
  projectsData: string[] | undefined;
  projectsLoading: boolean;
  envProfileId: string;
  setEnvProfileId: (value: string) => void;
  envOptions: ComboboxData;
  openEnvDrawer: () => void;
  section: string;
  setSection: (value: string) => void;
  sections: SectionSelectProps['sections'];
  perfType: PerformanceType;
  setPerfType: (value: PerformanceType) => void;
  perfTypeData: ComboboxData;
  tagsData: TagSelectorProps['tags'];
  tagsLoading: boolean;
  selectedTags: string[];
  setSelectedTags: (value: string[]) => void;
  excludedTags: string[];
  setExcludedTags: (value: string[]) => void;
}

export function RunTargetFields({
  isRunning,
  collapseToggle,
  typeAxis,
  sectionAxis,
  supportsTags,
  tools,
  tool,
  setTool,
  type,
  setType,
  typesData,
  project,
  setProject,
  projectsData,
  projectsLoading,
  envProfileId,
  setEnvProfileId,
  envOptions,
  openEnvDrawer,
  section,
  setSection,
  sections,
  perfType,
  setPerfType,
  perfTypeData,
  tagsData,
  tagsLoading,
  selectedTags,
  setSelectedTags,
  excludedTags,
  setExcludedTags,
}: RunTargetFieldsProps) {
  const t = useT();
  return (
    <>
      {/* Row 1 — WHAT to run. The three axes that decide the target sit on
          one line so the eye reads them together; the collapse toggle
          rides at the end instead of costing its own row. */}
      <Group gap="xs" align="flex-end" wrap="nowrap">
        <SimpleGrid
          cols={{ base: 1, xs: typeAxis ? 4 : 3 }}
          spacing="xs"
          style={{ flex: 1, minWidth: 0 }}
        >
          <Select
            label={t('run.tool')}
            size="xs"
            disabled={isRunning}
            value={tool}
            onChange={(v) => {
              if (!v) return;
              setTool(v as ToolId);
              setType('');
              setProject('');
              setSelectedTags([]);
            }}
            data={toolSelectData(tools)}
            allowDeselect={false}
          />
          {typeAxis && (
            <Select
              label={t('run.type')}
              size="xs"
              disabled={isRunning}
              value={type || null}
              onChange={(v) => {
                setType(v ?? '');
                setProject('');
                setSelectedTags([]);
              }}
              placeholder={t('common.select')}
              data={typesData ?? []}
              searchable
            />
          )}
          <Select
            label={t('run.project')}
            size="xs"
            disabled={isRunning}
            value={project || null}
            onChange={(v) => {
              setProject(v ?? '');
              setSelectedTags([]);
            }}
            placeholder={projectsLoading ? t('common.loading') : t('common.select')}
            data={projectsData ?? []}
            searchable
          />
          <Select
            label={t('run.environment')}
            size="xs"
            radius="xl"
            disabled={isRunning || !project}
            value={envProfileId}
            onChange={(v) => setEnvProfileId(v ?? ENV_CURRENT)}
            data={envOptions}
            allowDeselect={false}
            searchable
            rightSectionPointerEvents="auto"
            rightSectionWidth={34}
            rightSection={
              <Tooltip label={t('run.manageEnv')} withArrow>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="gray"
                  disabled={isRunning || !project}
                  onClick={(e) => {
                    e.stopPropagation();
                    openEnvDrawer();
                  }}
                  aria-label={t('run.manageEnv')}
                >
                  <TbSettings size={16} />
                </ActionIcon>
              </Tooltip>
            }
          />
        </SimpleGrid>
        {collapseToggle}
      </Group>

      {sectionAxis && project && (
        <SimpleGrid cols={2} spacing="xs">
          <SectionSelect
            label={t('run.section')}
            disabled={isRunning}
            value={section}
            onChange={setSection}
            placeholder={t('common.select')}
            sections={sections}
          />
          <Select
            label={t('run.perfType')}
            size="xs"
            disabled={isRunning}
            value={perfType}
            onChange={(v) => v && setPerfType(v as PerformanceType)}
            data={perfTypeData}
            allowDeselect={false}
          />
        </SimpleGrid>
      )}

      {supportsTags && project && !isRunning && (
        <TagSelector
          tags={tagsData}
          isLoading={tagsLoading}
          selectedTags={selectedTags}
          onChange={setSelectedTags}
          excludedTags={excludedTags}
          onExcludeChange={setExcludedTags}
          matchPanelAt="bottom"
          fill
        />
      )}
      {supportsTags && project && isRunning && selectedTags.length > 0 && (
        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            {t('run.tags')}
          </Text>
          <Group gap={4}>
            {selectedTags.map((tag) => (
              <Badge key={tag} size="sm" color="blue" variant="filled">
                {tag}
              </Badge>
            ))}
          </Group>
        </Stack>
      )}
    </>
  );
}
