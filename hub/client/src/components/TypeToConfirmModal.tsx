import { Alert, Button, Code, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { TbAlertTriangle } from 'react-icons/tb';
import { useT } from '~/i18n/index.js';

interface TypeToConfirmModalProps {
  readonly opened: boolean;
  readonly onClose: () => void;
  /** Modal title (e.g. "Remove project"). */
  readonly title: string;
  /** Short description of what will be deleted. */
  readonly description: ReactNode;
  /** The exact string the user must type to enable the confirm button. */
  readonly expected: string;
  /** Label for the destructive confirm button. */
  readonly confirmLabel: string;
  readonly loading?: boolean;
  readonly onConfirm: () => void;
}

/**
 * GitLab-style "type the name to confirm" guard for irreversible deletions.
 * The destructive button stays disabled until the typed value matches
 * `expected` exactly. Resets its input whenever it is (re)opened.
 */
export function TypeToConfirmModal({
  opened,
  onClose,
  title,
  description,
  expected,
  confirmLabel,
  loading,
  onConfirm,
}: TypeToConfirmModalProps) {
  const t = useT();
  const [value, setValue] = useState('');

  // Clear the field each time the modal opens so a stale match can't carry over.
  useEffect(() => {
    if (opened) setValue('');
  }, [opened]);

  const matches = value === expected;

  return (
    <Modal opened={opened} onClose={onClose} title={title} centered>
      <Stack gap="sm">
        <Alert color="red" variant="light" icon={<TbAlertTriangle size={16} />}>
          {t('confirmDelete.irreversible')}
        </Alert>
        <Text size="sm" component="div">
          {description}
        </Text>
        <Text size="sm">
          {t('confirmDelete.typePrompt')} <Code>{expected}</Code>
        </Text>
        <TextInput
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          placeholder={expected}
          autoFocus
          data-autofocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches && !loading) onConfirm();
          }}
        />
        <Group justify="flex-end" gap="xs">
          <Button variant="subtle" color="gray" size="xs" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button color="red" size="xs" disabled={!matches} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
