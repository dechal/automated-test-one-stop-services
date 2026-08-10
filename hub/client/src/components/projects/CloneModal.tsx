import type { ToolId } from '@hub/shared';
import { Select, TextInput } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { TbExternalLink } from 'react-icons/tb';
import { api } from '~/api/client.js';
import { FormModal } from '~/components/FormModal.js';
import { useProjectTypes } from '~/hooks/useProjectQueries.js';
import { useTools } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';
import { finalizeProjectSlug, toProjectSlug } from '~/utils/project-slug.js';
import { enabledTools, toolSelectData } from '~/utils/tool-label.js';

interface CloneModalProps {
  opened: boolean;
  onClose: () => void;
  onSuccess: () => void;
  /** When provided, pre-selects this tool on open (used by per-tool "Import project"). */
  initialTool?: ToolId;
}

/**
 * Clone an existing git repository into the appropriate project path. The tool
 * selector lists every ENABLED installed tool (`useTools()`); the type picker
 * shows only for `typeAxis` tools and its OPTIONS come from the server's real
 * type folders (`useProjectTypes`). The server uses `git` argv directly (no
 * shell), so URL/name/type cannot inject extra commands.
 */
export function CloneModal({ opened, onClose, onSuccess, initialTool }: CloneModalProps) {
  const t = useT();
  const { data: allTools = [] } = useTools();
  const tools = enabledTools(allTools);

  const [toolId, setToolId] = useState<ToolId>(initialTool ?? '');
  const [type, setType] = useState('');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');

  // Default to the first enabled tool once the list loads (unless pre-selected).
  useEffect(() => {
    if (!toolId && tools.length > 0) setToolId(tools[0]?.id ?? '');
  }, [tools, toolId]);

  const selectedTool = tools.find((t) => t.id === toolId);
  const { typeAxis, fixedType } = selectedTool?.projects ?? { typeAxis: true, fixedType: null };
  const showTypePicker = typeAxis && !fixedType;

  const typesQuery = useProjectTypes(showTypePicker ? toolId : '');
  const typeOptions = (typesQuery.data ?? []).map((t) => ({ value: t, label: t }));

  const effectiveType = fixedType ?? type;

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/api/projects/clone', {
        tool: toolId,
        type: effectiveType,
        url,
        // Blank means "keep the repo's own name", so an empty slug stays undefined
        // rather than posting an empty folder name.
        name: finalizeProjectSlug(name) || undefined,
      }),
    onSuccess,
  });

  // Sync the selected tool to `initialTool` each time the modal is (re)opened.
  useEffect(() => {
    if (opened && initialTool) {
      setToolId(initialTool);
      setType('');
    }
  }, [opened, initialTool]);

  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title={t('projects.cloneTitle')}
      submitLabel={t('projects.cloneButton')}
      onSubmit={() => mutation.mutate()}
      submitDisabled={!url || (showTypePicker && !effectiveType) || mutation.isPending}
      loading={mutation.isPending}
      error={mutation.isError ? (mutation.error as Error).message : null}
    >
      <Select
        label={t('run.tool')}
        value={toolId || null}
        onChange={(v) => {
          if (!v) return;
          setToolId(v as ToolId);
          setType('');
        }}
        data={toolSelectData(tools)}
        allowDeselect={false}
      />

      {showTypePicker && (
        <Select
          label={t('run.type')}
          value={type || null}
          onChange={(v) => setType(v ?? '')}
          data={typeOptions}
          placeholder={t('common.select')}
        />
      )}

      <TextInput
        label={t('projects.gitUrl')}
        leftSection={<TbExternalLink size={14} />}
        value={url}
        onChange={(e) => setUrl(e.currentTarget.value)}
        placeholder="https://github.com/org/repo.git"
      />
      {/* Same coercion as Create: this overrides the folder name on disk, so it
          carries the same kebab-case constraint. */}
      <TextInput
        label={t('projects.folderName')}
        description={t('projects.projectNameHint')}
        value={name}
        onChange={(e) => setName(toProjectSlug(e.currentTarget.value))}
        placeholder={t('projects.folderNamePlaceholder')}
      />
    </FormModal>
  );
}
