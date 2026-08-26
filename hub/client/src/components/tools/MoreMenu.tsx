import type { ToolView } from '@hub/shared';
import { ActionIcon, Loader, Menu, Tooltip } from '@mantine/core';
import { TbDotsVertical, TbDownload, TbFileText, TbRefresh, TbTrash } from 'react-icons/tb';
import { useT } from '~/i18n/index.js';

interface MoreMenuProps {
  readonly tool: ToolView;
  readonly onUpdate: () => void;
  readonly onReRunSetup: () => void;
  readonly reRunSetupLoading: boolean;
  readonly onUninstall: () => void;
  readonly uninstallDisabled: boolean;
  readonly uninstallTooltip: string;
}

/** Dropdown menu with additional actions: view manifest, update, re-run setup,
 *  uninstall. "Re-run setup" re-runs the tool's `setup` task (browser/binary
 *  download) so a version bump can be re-synced without the terminal — the same
 *  provision action the Environment panel offers when it detects a mismatch. */
export function MoreMenu({
  tool,
  onUpdate,
  onReRunSetup,
  reRunSetupLoading,
  onUninstall,
  uninstallDisabled,
  uninstallTooltip,
}: MoreMenuProps) {
  const t = useT();

  return (
    <Menu position="bottom-end" withArrow shadow="md">
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          size="sm"
          aria-label={`${t('moreMenu.moreActions')}: ${tool.title}`}
        >
          <TbDotsVertical size={16} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{t('moreMenu.actions')}</Menu.Label>

        <Menu.Item leftSection={<TbFileText size={14} />} disabled>
          {t('moreMenu.viewManifest')}
        </Menu.Item>

        {tool.origin === 'registry' && (
          <Menu.Item leftSection={<TbRefresh size={14} />} onClick={onUpdate}>
            {t('moreMenu.update')}
          </Menu.Item>
        )}

        <Tooltip label={t('moreMenu.reRunSetupHint')} withArrow position="left">
          <Menu.Item
            leftSection={reRunSetupLoading ? <Loader size={14} /> : <TbDownload size={14} />}
            disabled={reRunSetupLoading}
            onClick={onReRunSetup}
          >
            {t('moreMenu.reRunSetup')}
          </Menu.Item>
        </Tooltip>

        <Menu.Divider />

        <Tooltip label={uninstallTooltip} disabled={!uninstallDisabled}>
          <Menu.Item
            leftSection={<TbTrash size={14} />}
            color="red"
            disabled={uninstallDisabled}
            onClick={onUninstall}
          >
            {t('moreMenu.uninstall')}
          </Menu.Item>
        </Tooltip>
      </Menu.Dropdown>
    </Menu>
  );
}
