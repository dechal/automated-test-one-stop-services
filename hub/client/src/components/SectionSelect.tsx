import {
  Combobox,
  Group,
  Input,
  InputBase,
  Text,
  UnstyledButton,
  useCombobox,
} from '@mantine/core';
import { useMemo, useState } from 'react';
import { TbChevronDown, TbChevronRight } from 'react-icons/tb';
import { useCollapsedGroups } from '~/hooks/useCollapsedGroups.js';
import { useT } from '~/i18n/index.js';
import { groupSections, type SectionOption, sectionDisplayLabel } from '~/utils/section-options.js';

interface SectionSelectProps {
  /** Raw section paths from the API, e.g. `['motor/1-type-1', 'ta/domestic', ...]`. */
  sections: readonly string[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  size?: string;
}

/**
 * Section picker for k6 — a searchable dropdown whose nested sections are shown
 * under collapsible parent groups (e.g. `ta` › domestic/inbound/inter). Built on
 * Mantine's `Combobox` primitive because the plain `Select` supports neither
 * collapsible groups nor a custom group header. The submitted value is always
 * the full path (`ta/domestic`); the closed input shows it spaced (`ta / domestic`)
 * so the origin stays visible without opening the menu.
 */
export function SectionSelect({
  sections,
  value,
  onChange,
  label,
  placeholder,
  disabled,
  size = 'xs',
}: SectionSelectProps) {
  const t = useT();
  const [search, setSearch] = useState('');

  const combobox = useCombobox({
    onDropdownClose: () => {
      combobox.resetSelectedOption();
      setSearch('');
    },
    onDropdownOpen: () => combobox.focusSearchInput(),
  });

  const { ungrouped, groups } = useMemo(() => groupSections(sections), [sections]);

  const query = search.trim().toLowerCase();
  const { isCollapsed, toggle: toggleGroup } = useCollapsedGroups({ searching: query !== '' });
  const matches = (o: SectionOption): boolean =>
    query === '' || o.value.toLowerCase().includes(query) || o.label.toLowerCase().includes(query);

  const visibleUngrouped = ungrouped.filter(matches);
  const visibleGroups = groups
    .map((g) => ({ ...g, items: g.items.filter(matches) }))
    .filter((g) => g.items.length > 0);
  const nothingFound = visibleUngrouped.length === 0 && visibleGroups.length === 0;

  const renderOption = (o: SectionOption) => (
    <Combobox.Option key={o.value} value={o.value} active={o.value === value}>
      {o.label}
    </Combobox.Option>
  );

  return (
    <Combobox
      store={combobox}
      size={size}
      onOptionSubmit={(val) => {
        onChange(val);
        combobox.closeDropdown();
      }}
    >
      <Combobox.Target>
        <InputBase
          label={label}
          size={size}
          disabled={disabled}
          component="button"
          type="button"
          pointer
          rightSection={<Combobox.Chevron />}
          rightSectionPointerEvents="none"
          onClick={() => combobox.toggleDropdown()}
        >
          {value ? (
            sectionDisplayLabel(value)
          ) : (
            <Input.Placeholder>{placeholder ?? t('common.select')}</Input.Placeholder>
          )}
        </InputBase>
      </Combobox.Target>

      <Combobox.Dropdown>
        <Combobox.Search
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          placeholder={t('common.search')}
        />
        <Combobox.Options mah="30vh" style={{ overflowY: 'auto' }}>
          {visibleUngrouped.map(renderOption)}
          {visibleGroups.map((g) => {
            const collapsedGroup = isCollapsed(g.name);
            return (
              <div key={g.name}>
                <UnstyledButton w="100%" px="sm" py={4} onClick={() => toggleGroup(g.name)}>
                  <Group gap={6} wrap="nowrap">
                    {collapsedGroup ? <TbChevronRight size={14} /> : <TbChevronDown size={14} />}
                    <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                      {g.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      ({g.items.length})
                    </Text>
                  </Group>
                </UnstyledButton>
                {!collapsedGroup && g.items.map(renderOption)}
              </div>
            );
          })}
          {nothingFound && <Combobox.Empty>{t('common.noResults')}</Combobox.Empty>}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}
