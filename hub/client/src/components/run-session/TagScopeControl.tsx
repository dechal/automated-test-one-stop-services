import { SegmentedControl } from '@mantine/core';
import { SCOPE_ALL, SCOPE_BY_TAG } from '~/hooks/useTagScope.js';
import { useT } from '~/i18n/index.js';

const CONTROL_WIDTH = 280;

interface TagScopeControlProps {
  value: string;
  onChange: (value: string) => void;
  totalTests: number;
  disabled?: boolean;
}

export function TagScopeControl({ value, onChange, totalTests, disabled }: TagScopeControlProps) {
  const t = useT();
  return (
    <SegmentedControl
      size="xs"
      w={CONTROL_WIDTH}
      disabled={disabled}
      value={value}
      onChange={onChange}
      data={[
        {
          value: SCOPE_ALL,
          label: totalTests > 0 ? `${t('run.scopeAll')} · ${totalTests}` : t('run.scopeAll'),
        },
        { value: SCOPE_BY_TAG, label: t('run.scopeByTag') },
      ]}
    />
  );
}
