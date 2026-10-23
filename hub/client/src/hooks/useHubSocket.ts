import { useEffect } from 'react';

export type HubSocketEvent = { type: 'open' } | { type: 'message'; data: string };

export type HubSocketListener = (event: HubSocketEvent) => void;

interface HubSocketApi {
  send: (data: object) => void;
}

const RECONNECT_DELAY_MS = 2000;

const listeners = new Set<HubSocketListener>();
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let started = false;

function emit(event: HubSocketEvent): void {
  for (const listener of [...listeners]) listener(event);
}

function connect(): void {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
  socket = ws;
  ws.onopen = () => {
    // A fresh connection has no server-side subscriptions — tell every
    // subscriber so it can re-send whatever it needs on this socket.
    emit({ type: 'open' });
  };
  ws.onmessage = (event: MessageEvent) => {
    emit({ type: 'message', data: String(event.data) });
  };
  ws.onclose = () => {
    socket = null;
    // Keep the single app-level channel alive across transient drops.
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  };
  // A socket that errors while CONNECTING fires only `error`, never `close`,
  // so force-close to drive the reconnect via onclose.
  ws.onerror = () => ws.close();
}

function startIfNeeded(): void {
  if (started) return;
  started = true;
  connect();
}

/**
 * Register a listener on the single app-level WebSocket, opening the shared
 * connection on the first subscriber. Returns an unsubscribe function.
 *
 * The connection is kept open for the lifetime of the app once started: the
 * two app-shell listeners (`useRunFinishedNotifier`, `useScheduleToasts`)
 * mount once and never unmount, so tearing the socket down on the last
 * unsubscribe would only add churn on hot-reload. Reconnection fires an
 * `open` event so a listener can re-subscribe its server-side runs.
 */
export function subscribeHubSocket(listener: HubSocketListener): () => void {
  listeners.add(listener);
  startIfNeeded();
  // A listener added after the socket is already OPEN still needs the `open`
  // signal to seed its server-side subscriptions.
  if (socket?.readyState === WebSocket.OPEN) listener({ type: 'open' });
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Send a control message (subscribe/cancel) on the shared socket. No-ops when
 * the socket is not currently OPEN — callers re-send on the next `open` event.
 */
export function sendHubSocket(data: object): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
}

/** Test-only reset of the module singleton between cases. */
export function __resetHubSocketForTests(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  socket?.close();
  socket = null;
  started = false;
  listeners.clear();
}

/**
 * Hook wrapper: subscribe a listener for the lifetime of the mounting
 * component and expose `send`. The listener is captured once; callers that
 * read changing values should route them through refs (as the two app-shell
 * hooks do) rather than re-subscribing.
 */
export function useHubSocket(listener: HubSocketListener): HubSocketApi {
  // biome-ignore lint/correctness/useExhaustiveDependencies: subscribe exactly once; the listener reads live refs, not deps.
  useEffect(() => subscribeHubSocket(listener), []);
  return { send: sendHubSocket };
}
