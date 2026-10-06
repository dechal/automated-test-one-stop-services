import type { ToolId } from '@hub/shared';
import { Group, Loader, Paper, Select, Stack } from '@mantine/core';
import { useState } from 'react';
import { EnvProfileManager } from '~/components/env-profiles/EnvProfileManager.js';
import { PageHeader } from '~/components/PageHeader.js';
import { useProjectList, useProjectTypes } from '~/hooks/useProjectQueries';
import { useToolOptions } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';

export function EnvProfilesPage() {
  const t = useT();

  // Cascading selectors
  const [tool, setTool] = useState('playwright');
  const [type, setType] = useState('');
  const [project, setProject] = useState('');

  const types = useProjectTypes(tool as ToolId);
  const projects = useProjectList(tool as ToolId, type);
  const toolOptions = useToolOptions();

  return (
    <Stack gap="md">
      <PageHeader title={t('envProfiles.title')} description={t('nav.envProfiles.desc')} />

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
            placeholder={types.isLoading ? 'Loading...' : 'Select type...'}
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
              !type ? 'Select type first' : projects.isLoading ? 'Loading...' : 'Select project...'
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
