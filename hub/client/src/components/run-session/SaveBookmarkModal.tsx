import { Paper, SimpleGrid, Text, TextInput } from '@mantine/core';
import { FormModal } from '~/components/FormModal.js';
import { useT } from '~/i18n/index.js';

export interface SaveBookmarkSummaryRow {
  label: string;
  value: string;
}

export interface SaveBookmarkModalProps {
  opened: boolean;
  onClose: () => void;
  onSubmit: () => void;
  bookmarkName: string;
  setBookmarkName: (value: string) => void;
  loading: boolean;
  error: string | null;
  summary: SaveBookmarkSummaryRow[];
}

const SUMMARY_LABEL_WIDTH = 80;

export function SaveBookmarkModal({
  opened,
  onClose,
  onSubmit,
  bookmarkName,
  setBookmarkName,
  loading,
  error,
  summary,
}: SaveBookmarkModalProps) {
  const t = useT();
  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title={t('bookmark.saveCurrent')}
      submitLabel={t('bookmark.saveButton')}
      onSubmit={onSubmit}
      submitDisabled={!bookmarkName.trim()}
      loading={loading}
      error={error}
    >
      <TextInput
        label={t('bookmark.name')}
        description={t('bookmark.enterToSave')}
        value={bookmarkName}
        onChange={(e) => setBookmarkName(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit();
        }}
        data-autofocus
      />
      <Paper p="sm" mt="md" bg="var(--mantine-color-default-hover)">
        <SimpleGrid
          cols={2}
          spacing="sm"
          verticalSpacing={6}
          style={{ gridTemplateColumns: `${SUMMARY_LABEL_WIDTH}px minmax(0, 1fr)` }}
        >
          {summary.map((row) => [
            <Text key={`${row.label}-l`} size="xs" c="dimmed">
              {row.label}
            </Text>,
            <Text key={`${row.label}-v`} size="xs" style={{ overflowWrap: 'anywhere' }}>
              {row.value}
            </Text>,
          ])}
        </SimpleGrid>
      </Paper>
    </FormModal>
  );
}
