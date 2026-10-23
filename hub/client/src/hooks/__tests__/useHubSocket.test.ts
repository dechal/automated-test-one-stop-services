import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetHubSocketForTests,
  type HubSocketEvent,
  sendHubSocket,
  subscribeHubSocket,
} from '~/hooks/useHubSocket.js';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(data: string): void {
    this.onmessage?.({ data });
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

describe('useHubSocket shared connection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: 'localhost:5174' },
    });
  });

  afterEach(() => {
    __resetHubSocketForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('opens exactly one socket for two subscribers', () => {
    subscribeHubSocket(() => {});
    subscribeHubSocket(() => {});
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toBe('ws://localhost:5174/ws');
  });

  it('delivers every message to both subscribers', () => {
    const a: HubSocketEvent[] = [];
    const b: HubSocketEvent[] = [];
    subscribeHubSocket((e) => a.push(e));
    subscribeHubSocket((e) => b.push(e));
    const ws = FakeWebSocket.instances[0];
    ws?.open();
    ws?.message('{"kind":"run-started","runId":"r1"}');
    ws?.message('{"kind":"run-finished","runId":"r1"}');

    expect(a).toEqual([
      { type: 'open' },
      { type: 'message', data: '{"kind":"run-started","runId":"r1"}' },
      { type: 'message', data: '{"kind":"run-finished","runId":"r1"}' },
    ]);
    expect(b).toEqual(a);
  });

  it('reconnects after a close and emits open again to all subscribers', () => {
    const events: HubSocketEvent[] = [];
    subscribeHubSocket((e) => events.push(e));
    const first = FakeWebSocket.instances[0];
    first?.open();
    first?.close();
    // No new socket until the 2s reconnect delay elapses.
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.instances[1];
    second?.open();

    const opens = events.filter((e) => e.type === 'open');
    expect(opens).toHaveLength(2);
  });

  it('sends control messages only while the socket is open', () => {
    subscribeHubSocket(() => {});
    const ws = FakeWebSocket.instances[0];
    // Before open: dropped silently.
    sendHubSocket({ kind: 'subscribe', runId: 'r1', replay: true });
    expect(ws?.sent).toHaveLength(0);
    ws?.open();
    sendHubSocket({ kind: 'subscribe', runId: 'r1', replay: true });
    expect(ws?.sent).toEqual(['{"kind":"subscribe","runId":"r1","replay":true}']);
  });

  it('replays the open signal to a subscriber that joins after connect', () => {
    subscribeHubSocket(() => {});
    FakeWebSocket.instances[0]?.open();
    const late: HubSocketEvent[] = [];
    subscribeHubSocket((e) => late.push(e));
    expect(late).toEqual([{ type: 'open' }]);
  });

  it('closes the socket on error to drive the reconnect', () => {
    subscribeHubSocket(() => {});
    const ws = FakeWebSocket.instances[0];
    ws?.onerror?.();
    expect(ws?.readyState).toBe(FakeWebSocket.CLOSED);
    vi.advanceTimersByTime(2000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
