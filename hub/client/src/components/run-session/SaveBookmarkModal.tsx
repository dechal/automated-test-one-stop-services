import { TextInput } from '@mantine/core';
import { FormModal } from '~/components/FormModal.js';
import { useT } from '~/i18n/index.js';

export interface SaveBookmarkModalProps {
  opened: boolean;
  onClose: () => void;
  onSubmit: () => void;
  bookmarkName: string;
  setBookmarkName: (value: string) => void;
  loading: boolean;
  error: string | null;
}

export function SaveBookmarkModal({
  opened,
  onClose,
  onSubmit,
  bookmarkName,
  setBookmarkName,
  loading,
  error,
}: SaveBookmarkModalProps) {
  const t = useT();
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title={t('bookmark.saveCurrent')}
      submitLabel={t('common.save')}
      onSubmit={onSubmit}
      submitDisabled={!bookmarkName.trim()}
      loading={loading}
      error={error}
    >
      <TextInput
        label={t('bookmark.namePlaceholder')}
        placeholder={t('bookmark.namePlaceholder')}
        value={bookmarkName}
        onChange={(e) => setBookmarkName(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit();
        }}
        data-autofocus
      />
    </FormModal>
  );
}
