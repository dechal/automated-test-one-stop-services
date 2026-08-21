import type { RunStatus, WsServerEvent } from '@hub/shared';
import { formatExitCode } from '@hub/shared';
import { useCallback, useEffect, useRef } from 'react';
import { z } from 'zod';
import { api } from '~/api/client.js';
import { toast } from '~/components/Toast.js';
import { playFailureSound, playSuccessSound } from '~/hooks/useNotificationSound.js';
import type { RunTerminal } from '~/hooks/useRunTerminal.js';
import type { TranslationKey } from '~/i18n/en';
import { parseRunSummary, type RunSummary } from '~/utils/parse-run-summary.js';

/**
 * Minimal envelope guard for incoming WS frames: require an object with a
 * string `kind` (the discriminant the message switch reads) and pass the rest
 * through. Deliberately permissive on the payload so it never rejects a valid
 * frame as the WsServerEvent union evolves — the goal is to drop garbage, not
 * to re-validate the whole schema.
 */
const wsFrameSchema = z.looseObject({ kind: z.string() });

interface UseRunSocketOptions {
  /** Terminal API to write live output into. */
  term: RunTerminal;
  /** Ref holding the run id this session is currently listening for. */
  activeRunIdRef: React.RefObject<string | null>;
  /** Accumulates the full stdout/stderr stream for summary parsing. */
  fullOutputRef: React.MutableRefObject<string>;
  setRunStatus: (status: RunStatus | 'idle') => void;
  setRunSummary: (summary: RunSummary | null) => void;
  setActiveRunId: (id: string | null) => void;
  setLastCommand: (command: string) => void;
  /** Present when this session was created to reconnect to an in-flight run. */
  reconnectRunId?: string;
  reconnectCommand?: string;
  t: (key: TranslationKey) => string;
}

/**
 * Owns the per-session WebSocket: connection lifecycle, server-event routing
 * (stdout/stderr/started/finished), and reconnection to an in-flight run after
 * a page reload. Extracted from RunSession so the socket/terminal plumbing is
 * isolated from the component's form state.
 *
 * Returns `send`, a thin wrapper that JSON-encodes control messages
 * (subscribe/cancel) to the server.
 */
export function useRunSocket({
  term,
  activeRunIdRef,
  fullOutputRef,
  setRunStatus,
  setRunSummary,
  setActiveRunId,
  setLastCommand,
  reconnectRunId,
  reconnectCommand,
  t,
}: UseRunSocketOptions): { send: (data: object) => void } {
  const wsRef = useRef<WebSocket | null>(null);

  const send = useCallback((data: object) => {
    wsRef.current?.send(JSON.stringify(data));
  }, []);

  // WebSocket per session (connect once on mount).
  // biome-ignore lint/correctness/useExhaustiveDependencies: connect exactly once; handler reads live refs, not deps.
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;
    ws.onmessage = (event) => {
      // A malformed / non-JSON frame must not throw in onmessage (which would
      // silently stop live output). Parse defensively and require the `kind`
      // discriminant the switch below relies on; the payload is passed through.
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = wsFrameSchema.safeParse(raw);
      if (!parsed.success) return;
      const msg = parsed.data as unknown as WsServerEvent;
      if (!term.ready()) return;
      switch (msg.kind) {
        case 'run-started':
          if (msg.runId === activeRunIdRef.current) {
            setRunStatus('running');
          }
          break;
        case 'run-stdout':
          if (msg.runId === activeRunIdRef.current) {
            term.write(msg.chunk);
            fullOutputRef.current += msg.chunk;
          }
          break;
        case 'run-stderr':
          if (msg.runId === activeRunIdRef.current) {
            term.write(`\x1b[31m${msg.chunk}\x1b[0m`);
            fullOutputRef.current += msg.chunk;
          }
          break;
        case 'run-finished':
          if (msg.runId === activeRunIdRef.current) {
            setRunStatus(msg.record.status);
            const summary = parseRunSummary(fullOutputRef.current);
            if (summary) setRunSummary(summary);
            // `record.exitCode` is go-task's, which is a fixed 201 for ANY task
            // failure — show the tool's own code alongside it (see formatExitCode).
            const exitLabel = formatExitCode(msg.record.exitCode, fullOutputRef.current);
            term.writeln(
              `\n\x1b[${msg.record.status === 'passed' ? '32' : '31'}m[${msg.record.status.toUpperCase()}]\x1b[0m Exit code: ${exitLabel}`,
            );
            if (msg.record.status === 'passed') {
              toast.success(`${t('run.testPassed')} (${msg.record.request.project})`, {
                id: `run-${msg.runId}`,
              });
              playSuccessSound();
            } else if (msg.record.status === 'failed') {
              toast.error(`${t('run.testFailed')} (${msg.record.request.project})`, {
                id: `run-${msg.runId}`,
              });
              playFailureSound();
            } else if (msg.record.status === 'cancelled') {
              toast.info(`${t('run.testCancelled')} (${msg.record.request.project})`, {
                id: `run-${msg.runId}`,
              });
            }
          }
          break;
      }
    };
    return () => {
      ws.close();
    };
  }, []);

  // Reconnect to an active run (after page refresh).
  // biome-ignore lint/correctness/useExhaustiveDependencies: respond only to reconnect target changes; helpers/refs are stable.
  useEffect(() => {
    if (!reconnectRunId) return;
    const runId = reconnectRunId;
    // Track EVERY timer this effect schedules (the initial 600ms, the recursive
    // waitForWs poll, and the 2000ms re-check) plus a cancelled flag, so unmount
    // / reconnect-target change cancels all of them. Otherwise the recursive
    // poll and the delayed re-check would fire ws.send on a closing socket and
    // setState/term.writeln after unmount.
    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const track = (fn: () => void, ms: number): void => {
      const id = setTimeout(() => {
        timers.delete(id);
        if (!cancelled) fn();
      }, ms);
      timers.add(id);
    };
    async function doReconnect() {
      if (cancelled) return;
      setActiveRunId(runId);
      setRunStatus('running');
      setLastCommand(reconnectCommand ?? '');
      try {
        const { output } = (await api.get(`/api/runs/${runId}/output`)) as { output: string };
        if (cancelled) return;
        if (term.ready()) {
          term.clear();
          term.writeln(`\x1b[32m[Reconnected]\x1b[0m Run ${runId}`);
          if (reconnectCommand) term.writeln(`\x1b[90m$ ${reconnectCommand}\x1b[0m\n`);
          term.write(output);
        }
      } catch {
        if (cancelled) return;
        setRunStatus('idle');
        if (term.ready()) {
          term.clear();
          term.writeln(`\x1b[33m[Finished]\x1b[0m Run ${runId} has already completed.`);
        }
        return;
      }
      const waitForWs = () => {
        if (cancelled) return;
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ kind: 'subscribe', runId }));
        } else {
          track(waitForWs, 200);
        }
      };
      waitForWs();

      track(() => {
        void (async () => {
          try {
            await api.get(`/api/runs/${runId}/output`);
          } catch {
            if (cancelled) return;
            setRunStatus('idle');
            term.writeln(`\n\x1b[33m[Finished]\x1b[0m Run completed while reconnecting.`);
          }
        })();
      }, 2000);
    }
    track(() => void doReconnect(), 600);
    return () => {
      cancelled = true;
      for (const id of timers) clearTimeout(id);
    };
  }, [reconnectRunId, reconnectCommand]);

  return { send };
}
