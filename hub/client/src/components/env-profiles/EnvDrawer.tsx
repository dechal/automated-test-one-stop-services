import { Drawer } from '@mantine/core';
import { useT } from '~/i18n/index.js';
import { EnvProfileManager } from './EnvProfileManager.js';

interface EnvDrawerProps {
  opened: boolean;
  onClose: () => void;
  tool: string;
  type: string;
  project: string;
}

/**
 * Right-side Drawer that wraps {@link EnvProfileManager} for the (tool,type,
 * project) the run form has selected, so managing env profiles is one click
 * from Run without leaving the page.
 */
export function EnvDrawer({ opened, onClose, tool, type, project }: EnvDrawerProps) {
  const t = useT();
  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="lg" title={t('run.manageEnv')}>
      <EnvProfileManager tool={tool} type={type} project={project} />
    </Drawer>
  );
}
