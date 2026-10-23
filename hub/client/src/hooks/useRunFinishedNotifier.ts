import type { RunRecord, WsServerEvent } from '@hub/shared';
import { useCallback, useEffect, useRef } from 'react';
import { notifyRunFinished } from '~/hooks/useDesktopNotification.js';
import { type HubSocketEvent, sendHubSocket, subscribeHubSocket } from '~/hooks/useHubSocket.js';
import { useT } from '~/i18n/index.js';

/**
 * App-level desktop notification for interactive run completion.
 *
 * The per-session socket in `RunSession` only exists while the Run page is
 * open, so a run that finished while the user was on another page never raised
 * an OS notification (the reported bug). This hook is mounted once in the app
 * shell and keeps a socket alive on every page.
 *
 * The server forwards `run-finished` only to sockets subscribed to that run
 * (ws.ts), while `run-started` is broadcast to all. So this socket subscribes
 * to (a) every run announced via `run-started`, and (b) every currently-active
 * run (with `replay`, to catch one that just finished). `notifyRunFinished`
 * no-ops unless the desktop toggle is on and the tab is hidden, so it never
 * competes with RunSession's in-app toast/sound.
 */
export function useRunFinishedNotifier(activeRuns: RunRecord[]): void {
  const t = useT();
  const subscribedRef = useRef<Set<string>>(new Set());
  const notifiedRef = useRef<Set<string>>(new Set());
  const activeRunsRef = useRef<RunRecord[]>(activeRuns);
  activeRunsRef.current = activeRuns;
  // Keep the translator in a ref so the subscription can read the latest value
  // without re-subscribing (which would tear down and re-open the shared
  // socket channel on every language change).
  const tRef = useRef(t);
  tRef.current = t;

  const subscribe = useCallback((runId: string, replay: boolean) => {
    if (!subscribedRef.current.has(runId)) {
      sendHubSocket({ kind: 'subscribe', runId, replay });
      subscribedRef.current.add(runId);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: subscribe exactly once; the listener reads live refs, not deps.
  useEffect(() => {
    const onEvent = (event: HubSocketEvent) => {
      if (event.type === 'open') {
        // A fresh connection has no server-side subscriptions — re-subscribe to
        // whatever is currently active (replay catches a just-finished run).
        subscribedRef.current.clear();
        for (const run of activeRunsRef.current) subscribe(run.id, true);
        return;
      }
      let msg: WsServerEvent;
      try {
        msg = JSON.parse(event.data) as WsServerEvent;
      } catch {
        return;
      }
      if (msg.kind === 'run-started') {
        subscribe(msg.runId, false);
        return;
      }
      if (msg.kind !== 'run-finished' || notifiedRef.current.has(msg.runId)) return;
      const { status, request } = msg.record;
      if (status !== 'passed' && status !== 'failed') return;
      notifiedRef.current.add(msg.runId);
      notifyRunFinished({
        title:
          status === 'passed' ? tRef.current('run.testPassed') : tRef.current('run.testFailed'),
        body: request.project,
        tag: `run-${msg.runId}`,
      });
    };
    return subscribeHubSocket(onEvent);
  }, []);

  // Subscribe to active runs as the poll surfaces them (covers a run already in
  // flight when this hook mounted). Idempotent via `subscribedRef`.
  useEffect(() => {
    for (const run of activeRuns) subscribe(run.id, true);
  }, [activeRuns, subscribe]);
}
