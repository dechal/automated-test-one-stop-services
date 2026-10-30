import type { ToolId } from '@hub/shared';
import { Group, Loader, Paper, Select, Stack } from '@mantine/core';
import { useState } from 'react';
import { EnvProfileManager } from '~/components/env-profiles/EnvProfileManager.js';
import { useProjectList, useProjectTypes } from '~/hooks/useProjectQueries';
import { useToolOptions, useTools } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';
import { DEFAULT_TOOL } from '~/stores/hub.js';
import { firstEnabledTool } from '~/utils/tool-label.js';

export function EnvProfilesBody() {
  const t = useT();

  // Cascading selectors
  const [toolChoice, setTool] = useState('');
  const { data: allTools = [] } = useTools();
  const tool = toolChoice || firstEnabledTool(allTools, DEFAULT_TOOL);
  const [type, setType] = useState('');
  const [project, setProject] = useState('');

  const types = useProjectTypes(tool as ToolId);
  const projects = useProjectList(tool as ToolId, type);
  const toolOptions = useToolOptions();

  return (
    <Stack gap="md">
      {/* Cascading project selector */}
      <Paper p="md" withBorder>
        <Group gap="sm" wrap="wrap">
          <Select
            label={t('run.tool')}
            size="xs"
            w={160}
            value={tool}
            onChange={(v) => {
              if (!v) return;
              setTool(v);
              setType('');
              setProject('');
            }}
            data={toolOptions}
            allowDeselect={false}
          />
          <Select
            label={t('table.type')}
            size="xs"
            w={160}
            value={type || null}
            onChange={(v) => {
              setType(v ?? '');
              setProject('');
            }}
            placeholder={types.isLoading ? t('common.loading') : t('webhook.selectType')}
            data={types.data ?? []}
            disabled={types.isLoading}
            rightSection={types.isLoading ? <Loader size={14} /> : undefined}
            searchable
          />
          <Select
            label={t('run.project')}
            size="xs"
            w={200}
            value={project || null}
            onChange={(v) => setProject(v ?? '')}
            placeholder={
              !type
                ? t('webhook.selectTypeFirst')
                : projects.isLoading
                  ? t('common.loading')
                  : t('webhook.selectProject')
            }
            data={projects.data ?? []}
            disabled={!type || projects.isLoading}
            rightSection={projects.isLoading ? <Loader size={14} /> : undefined}
            searchable
          />
        </Group>
      </Paper>

      <EnvProfileManager tool={tool} type={type} project={project} />
    </Stack>
  );
}
