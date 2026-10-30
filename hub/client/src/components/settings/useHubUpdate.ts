import { useState } from 'react';
import { api } from '~/api/client';
import { waitForHealth } from '~/api/health.js';
import { confirmDialog } from '~/components/confirmDialog';
import { toast } from '~/components/Toast';
import { useT } from '~/i18n';

interface UpdateStatusResponse {
  running: boolean;
  stage: 'idle' | 'shared' | 'client' | 'server' | 'restarting' | 'done';
  error?: string;
  finishedAt?: string;
}

/**
 * Poll /api/system/update/status until the server reports the build is done
 * (or has errored). Resolves with the terminal status object. `labels` maps
 * each stage to an already-translated string so status text is localized.
 */
async function pollUpdateStatus(
  setStage: (s: string) => void,
  timeoutMs: number,
  labels: Record<UpdateStatusResponse['stage'], string>,
): Promise<UpdateStatusResponse> {
  const start = Date.now();
  let last: UpdateStatusResponse = { running: true, stage: 'shared' };
  while (Date.now() - start < timeoutMs) {
    try {
      last = await api.get<UpdateStatusResponse>('/api/system/update/status');
      setStage(labels[last.stage] || '');
      if (!last.running) return last;
      // While restarting, the next poll may fail because the server is gone.
      // The outer flow handles that via waitForHealth.
      if (last.stage === 'restarting') return last;
    } catch {
      // server bouncing — caller will fall back to waitForHealth
      return last;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
}

export interface HubUpdateState {
  isUpdating: boolean;
  updateStatus: string | null;
  runUpdate: () => Promise<void>;
}

export function useHubUpdate(): HubUpdateState {
  const t = useT();

  // System update state
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);

  const runUpdate = async () => {
    setIsUpdating(true);
    setUpdateStatus(t('settings.startingBuild'));
    try {
      await api.post<{ ok: boolean; message: string }>('/api/system/update', {});

      // Server now runs the build in the background and returns 202 immediately.
      // Poll the status endpoint to surface real stage transitions to the user.
      const stageLabels: Record<UpdateStatusResponse['stage'], string> = {
        idle: '',
        shared: t('settings.buildingShared'),
        client: t('settings.buildingClient'),
        server: t('settings.buildingServer'),
        restarting: t('settings.restartingHub'),
        done: t('settings.updateDoneStatus'),
      };
      const final = await pollUpdateStatus(setUpdateStatus, 5 * 60_000, stageLabels);

      if (final.error) {
        setUpdateStatus(null);
        setIsUpdating(false);
        const finalError = final.error;
        toast.error(t('settings.updateFailed').replace('{error}', () => finalError));
        return;
      }

      setUpdateStatus(t('settings.buildDoneRestarting'));

      // Wait until /api/health responds again (server has restarted).
      const healthOk = await waitForHealth(60_000);
      if (!healthOk) {
        setUpdateStatus(null);
        setIsUpdating(false);
        toast.error(t('settings.serverTimeout'));
        return;
      }

      setUpdateStatus(t('settings.updateDoneStatus'));
      toast.success(t('settings.updateDoneToast'));
      const reload = await confirmDialog({
        title: t('settings.reloadTitle'),
        message: t('settings.reloadQuestion'),
        confirmLabel: t('settings.reloadLabel'),
        cancelLabel: t('common.later'),
        isShowClose: false,
        isShowCancel: false,
        isCloseOnClickOutside: false,
        isCloseOnEscape: false,
      });
      if (reload) {
        window.location.reload();
      } else {
        setIsUpdating(false);
      }
    } catch (err) {
      setUpdateStatus(null);
      setIsUpdating(false);
      const error = err as Error & { stage?: string };
      const stage = error.stage ? ` (${error.stage})` : '';
      const message = error.message || t('settings.unknownError');
      toast.error(
        t('settings.updateHubFailed')
          .replace('{stage}', () => stage)
          .replace('{error}', () => message),
      );
    }
  };

  return { isUpdating, updateStatus, runUpdate };
}
