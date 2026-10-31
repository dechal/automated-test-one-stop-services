import { Select } from '@mantine/core';
import { useT } from '~/i18n/index.js';

export const CI_CHOICES = ['none', 'gitlab', 'github', 'both'] as const;
export type CiChoice = (typeof CI_CHOICES)[number];

interface CiProviderSelectProps {
  value: CiChoice;
  onChange: (value: CiChoice) => void;
  disabled?: boolean;
}

function isCiChoice(value: string | null): value is CiChoice {
  return value !== null && (CI_CHOICES as readonly string[]).includes(value);
}

export function CiProviderSelect({ value, onChange, disabled }: CiProviderSelectProps) {
  const t = useT();
  return (
    <Select
      label={t('ciSelect.label')}
      description={t('ciSelect.desc')}
      data={CI_CHOICES.map((choice) => ({ value: choice, label: t(`ciSelect.${choice}`) }))}
      value={value}
      onChange={(next) => onChange(isCiChoice(next) ? next : 'none')}
      allowDeselect={false}
      disabled={disabled}
    />
  );
}
