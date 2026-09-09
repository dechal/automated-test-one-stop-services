import type { WsServerEvent } from '@hub/shared';
import { notifications } from '@mantine/notifications';
import { useEffect } from 'react';
import {
  buildScheduleToast,
  shouldShowScheduleToast,
} from '~/components/schedule-toast-helpers.js';
import { notifyRunFinished } from '~/hooks/useDesktopNotification.js';
import { translate } from '~/i18n/index.js';
import { usePreferences } from '~/stores/hub.js';

/**
 * App-level listener for the `schedule-finished` WebSocket event.
 *
 * The server broadcasts `schedule-finished` to *every* socket regardless of
 * subscription (ws.ts), so this hook opens its own connection to
 * `/ws` and surfaces a Corner_Toast on any page — independent of the per-run
 * socket owned by `RunSession`. `RunSession` has no `schedule-finished` case,
 * so it ignores the broadcast and there is no double-toast.
 *
 * Behaviour:
 * - Gate via `shouldShowScheduleToast(event, prefs)` — silent schedules whose
 *   per-scheduleId toast preference is disabled produce no toast;
 *   a missing entry defaults to enabled.
 * - Build the descriptor with `buildScheduleToast(event)` and show it through
 *   Mantine `notifications.show(...)` (passed → success/5s, otherwise
 *   error/10s). The toast id is bound to the runId
 *   so concurrent completions render as distinct toasts.
 * - Corner_Toast is ephemeral: this never writes to the `useNotifications`
 *   store, localStorage, or run history.
 */
export function useScheduleToasts(): void {
  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    function handleMessage(event: MessageEvent): void {
      let msg: WsServerEvent;
      try {
        msg = JSON.parse(event.data) as WsServerEvent;
      } catch {
        return;
      }
      if (msg.kind === 'schedule-skipped') {
        notifications.show({
          id: `schedule-skipped-${msg.scheduleId}`,
          color: 'yellow',
          title: translate('schedule.skipped'),
          message: `${msg.scheduleName} — ${msg.message}`,
          autoClose: 10000,
        });
        return;
      }
      if (msg.kind === 'run-report-missing') {
        notifications.show({
          id: `run-report-missing-${msg.runId}`,
          color: 'yellow',
          title: translate('run.reportMissing'),
          message: `${msg.label} — ${translate('run.reportMissingBody')}`,
          autoClose: 10000,
        });
        return;
      }
      if (msg.kind !== 'schedule-finished') return;

      // Read prefs lazily so the latest per-scheduleId switch is honoured.
      if (!shouldShowScheduleToast(msg, usePreferences.getState())) return;

      const toast = buildScheduleToast(msg);
      // Ephemeral only — do NOT persist to useNotifications/localStorage/history.
      notifications.show({
        id: toast.id,
        color: toast.color,
        title: toast.title,
        message: toast.message,
        autoClose: toast.autoClose,
      });
      // Mirror as an OS notification when the tab is backgrounded (no-ops when
      // the desktop-notification toggle is off or permission is not granted).
      notifyRunFinished({ title: toast.title, body: toast.message, tag: toast.id });
    }

    function connect(): void {
      if (disposed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socket = ws;
      ws.onmessage = handleMessage;
      ws.onclose = () => {
        if (disposed) return;
        // Keep the app-level toast channel alive across transient drops.
        reconnectTimer = setTimeout(connect, 2000);
      };
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);
}
