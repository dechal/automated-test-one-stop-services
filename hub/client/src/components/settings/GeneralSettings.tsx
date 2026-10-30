import {
  Button,
  Group,
  Paper,
  Select,
  SimpleGrid,
  Skeleton,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  useMantineColorScheme,
} from '@mantine/core';
import { TbMoonStars, TbSun, TbUser } from 'react-icons/tb';
import { toast } from '~/components/Toast';
import type { useHubUser, useSaveHubUser } from '~/hooks/useHubUser.js';
import { type Locale, useI18nStore, useT } from '~/i18n';
import { usePreferences } from '~/stores/hub.js';

export interface GeneralSettingsProps {
  hubUser: ReturnType<typeof useHubUser>;
  saveUser: ReturnType<typeof useSaveHubUser>;
  nameInput: string;
  setNameInput: (value: string) => void;
}

export function GeneralSettings({
  hubUser,
  saveUser,
  nameInput,
  setNameInput,
}: GeneralSettingsProps) {
  const t = useT();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const { locale, setLocale } = useI18nStore();
  const advancedMode = usePreferences((s) => s.advancedMode);
  const setAdvancedMode = usePreferences((s) => s.setAdvancedMode);
  return (
    <>
      {/* Two cards, not three. Theme and language are the same concern (how the
          Hub presents itself) and each held a single row, so in a 3-up grid they
          were stretched to the height of the 2-row Notifications card and carried
          ~100px of empty space each. Merged, both columns hold two rows and the
          row has no dead space. */}
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        {/* Display — theme + language */}
        <Paper p="md" withBorder>
          <Title order={2} size="h5" mb="sm">
            {t('settings.appearance')}
          </Title>
          <Stack gap="sm">
            <Group justify="space-between">
              <Stack gap={2}>
                <Text size="sm">{t('settings.colorScheme')}</Text>
                <Text size="xs" c="dimmed">
                  {t('settings.colorSchemeDesc')}
                </Text>
              </Stack>
              <Select
                size="xs"
                w={140}
                value={colorScheme}
                onChange={(v) => v && setColorScheme(v as 'light' | 'dark' | 'auto')}
                data={[
                  { value: 'dark', label: t('settings.dark') },
                  { value: 'light', label: t('settings.light') },
                  { value: 'auto', label: t('settings.system') },
                ]}
                allowDeselect={false}
                leftSection={
                  colorScheme === 'dark' ? <TbMoonStars size={14} /> : <TbSun size={14} />
                }
              />
            </Group>
            <Group justify="space-between">
              <Stack gap={2}>
                <Text size="sm">{t('settings.interfaceLanguage')}</Text>
                <Text size="xs" c="dimmed">
                  {t('settings.interfaceLanguageDesc')}
                </Text>
              </Stack>
              <Select
                size="xs"
                w={140}
                value={locale}
                onChange={(v) => v && setLocale(v as Locale)}
                data={[
                  { value: 'en', label: 'English' },
                  { value: 'th', label: 'ไทย' },
                ]}
                allowDeselect={false}
              />
            </Group>
          </Stack>
        </Paper>

        <Paper p="md" withBorder>
          <Group justify="space-between" mb="sm" wrap="nowrap" align="flex-start">
            <Title order={2} size="h5">
              {t('common.advancedMode')}
            </Title>
            <Switch
              size="md"
              checked={advancedMode}
              onChange={(e) => setAdvancedMode(e.currentTarget.checked)}
              aria-label={t('common.advancedMode')}
            />
          </Group>
          <Stack gap="xs">
            <Text size="xs" c="dimmed">
              {advancedMode ? t('common.advancedModeOn') : t('common.advancedModeOff')}
            </Text>
            <Text size="xs" c="dimmed">
              {t('settings.advancedModeReveals')}
            </Text>
            <Stack gap={4} component="ul" pl="md" style={{ margin: 0 }}>
              <Text size="xs" c="dimmed" component="li">
                {t('settings.advancedModeRevealRun')}
              </Text>
              <Text size="xs" c="dimmed" component="li">
                {t('settings.advancedModeRevealColumns')}
              </Text>
              <Text size="xs" c="dimmed" component="li">
                {t('settings.advancedModeRevealDoctor')}
              </Text>
            </Stack>
          </Stack>
        </Paper>
      </SimpleGrid>

      {/* Identity — the name stamped into test-case "Edited By" */}
      <Paper p="md" withBorder>
        <Title order={2} size="h5" mb="sm">
          {t('user.identity')}
        </Title>
        <Stack gap="sm">
          <Stack gap={2}>
            <Text size="sm">{t('user.name')}</Text>
            <Text size="xs" c="dimmed">
              {t('user.nameDesc')}
            </Text>
          </Stack>
          {hubUser.isLoading ? (
            <Skeleton height={30} radius="sm" aria-hidden />
          ) : (
            <Group gap="xs" wrap="nowrap">
              <TextInput
                size="xs"
                style={{ flex: 1 }}
                leftSection={<TbUser size={14} />}
                placeholder={t('user.namePlaceholder')}
                value={nameInput}
                onChange={(e) => setNameInput(e.currentTarget.value)}
                error={saveUser.error ? saveUser.error.message : null}
              />
              <Button
                size="xs"
                loading={saveUser.isPending}
                disabled={
                  nameInput.trim() === '' || nameInput.trim() === (hubUser.user?.name ?? '')
                }
                onClick={() =>
                  saveUser.mutate(nameInput.trim(), {
                    onSuccess: (res) =>
                      toast.success(
                        res.rowsRenamed > 0
                          ? `${t('user.renamed')} — ${res.rowsRenamed} ${t('user.rowsUpdated')}`
                          : t('user.saved'),
                      ),
                  })
                }
              >
                {t('common.save')}
              </Button>
            </Group>
          )}
        </Stack>
      </Paper>
    </>
  );
}
