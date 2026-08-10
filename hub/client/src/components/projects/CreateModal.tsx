import type { ToolId } from '@hub/shared';
import { Select, Stack, TextInput } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '~/api/client.js';
import { FormModal } from '~/components/FormModal.js';
import { useProjectTypes } from '~/hooks/useProjectQueries.js';
import { useTools } from '~/hooks/useTools.js';
import { useT } from '~/i18n/index.js';
import { finalizeProjectSlug, toProjectSlug } from '~/utils/project-slug.js';
import { enabledTools, toolSelectData } from '~/utils/tool-label.js';

interface CreateModalProps {
  opened: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

/**
 * Create a fresh project folder under `tools/<tool>/<type>/<name>` via the
 * server's `task create-project` recipe. The tool selector lists every ENABLED
 * installed tool (`useTools()`); whether a type picker shows is decided by the
 * selected tool's manifest (`typeAxis` / `fixedType`); the type OPTIONS come
 * from the server's real type folders (`useProjectTypes`) plus a custom entry.
 */
export function CreateModal({ opened, onClose, onSuccess }: CreateModalProps) {
  const t = useT();
  const { data: allTools = [] } = useTools();
  const tools = enabledTools(allTools);

  const [toolId, setToolId] = useState<ToolId>('');
  const [type, setType] = useState('');
  const [customType, setCustomType] = useState('');
  const [isCustom, setIsCustom] = useState(false);
  const [name, setName] = useState('');

  // Default to the first enabled tool once the list loads.
  useEffect(() => {
    if (!toolId && tools.length > 0) setToolId(tools[0]?.id ?? '');
  }, [tools, toolId]);

  const selectedTool = tools.find((t) => t.id === toolId);
  const { typeAxis, fixedType } = selectedTool?.projects ?? { typeAxis: true, fixedType: null };
  const showTypePicker = typeAxis && !fixedType;

  // Real existing type folders for this tool (manifest-driven on the server).
  const typesQuery = useProjectTypes(showTypePicker ? toolId : '');
  const typeOptions = [
    ...(typesQuery.data ?? []).map((t) => ({ value: t, label: t })),
    { value: '__custom__', label: t('projects.customTypeOption') },
  ];

  const effectiveType = fixedType ?? (isCustom ? finalizeProjectSlug(customType) : type);

  // `name` may end in the separator while the user is mid-word; the folder never
  // should, so the trailing one is dropped at the boundary.
  const finalName = finalizeProjectSlug(name);

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/api/projects/create', {
        tool: toolId,
        type: showTypePicker ? effectiveType : undefined,
        name: finalName,
      }),
    onSuccess,
  });

  const submitDisabled =
    !finalName || !toolId || (showTypePicker && !effectiveType) || mutation.isPending;

  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title={t('projects.createTitle')}
      submitLabel={t('common.create')}
      onSubmit={() => mutation.mutate()}
      submitDisabled={submitDisabled}
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
          setIsCustom(false);
        }}
        data={toolSelectData(tools)}
        allowDeselect={false}
      />

      {showTypePicker && (
        <Stack gap="xs">
          <Select
            label={t('run.type')}
            value={isCustom ? '__custom__' : type || null}
            onChange={(v) => {
              if (v === '__custom__') {
                setIsCustom(true);
                setCustomType('');
              } else if (v) {
                setIsCustom(false);
                setType(v);
              }
            }}
            data={typeOptions}
            placeholder={t('projects.selectType')}
            allowDeselect={false}
          />
          {isCustom && (
            // A type is a folder segment too (`tools/<tool>/<type>/<name>`), so it
            // takes the same kebab-case coercion as the project name.
            <TextInput
              value={customType}
              onChange={(e) => setCustomType(toProjectSlug(e.currentTarget.value))}
              placeholder={t('projects.customTypePlaceholder')}
              autoFocus
            />
          )}
        </Stack>
      )}

      <TextInput
        label={t('projects.projectName')}
        description={t('projects.projectNameHint')}
        value={name}
        // Coerced on every keystroke rather than validated on submit: the field
        // can then never hold a name the filesystem would reject, and typing a
        // space simply produces the separator instead of an error to read.
        onChange={(e) => setName(toProjectSlug(e.currentTarget.value))}
        placeholder="my-awesome-project"
      />
    </FormModal>
  );
}
