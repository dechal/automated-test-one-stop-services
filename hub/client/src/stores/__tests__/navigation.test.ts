import type { QueueStatus, RunRecord } from '@hub/shared';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunTerminal } from '~/hooks/useRunTerminal.js';
import {
  type FetchJson,
  OUTPUT_TAIL_LIMIT,
  recordingTerminal,
  resolveReconnectPhase,
  useRunSessions,
  useSessionField,
} from '~/stores/navigation.js';

function runRecord(id: string, status: RunRecord['status']): RunRecord {
  return {
    id,
    request: { tool: 'playwright', type: 'web', project: 'my-project', mode: 'local' },
    command: 'task run',
    status,
    startedAt: '2026-01-01T00:00:00.000Z',
  };
}

function fakeFetch(
  queue: QueueStatus,
  output: () => Promise<{ output: string }>,
): { fetchJson: FetchJson; calls: string[] } {
  const calls: string[] = [];
  const fetchJson = vi.fn(async (path: string): Promise<unknown> => {
    calls.push(path);
    if (path === '/api/queue') return queue;
    return output();
  }) as unknown as FetchJson;
  return { fetchJson, calls };
}

function queueOf(queued: RunRecord[]): QueueStatus {
  return { active: [], queued, activeCount: 0, queueLength: queued.length, maxConcurrency: 2 };
}

describe('resolveReconnectPhase', () => {
  it('keeps a queued run in flight without asking for its output', async () => {
    const output = vi.fn(async (): Promise<{ output: string }> => {
      throw Object.assign(new Error('Run not found or already finished'), { code: 'NOT_FOUND' });
    });
    const { fetchJson, calls } = fakeFetch(queueOf([runRecord('run-q', 'pending')]), output);
    await expect(resolveReconnectPhase('run-q', fetchJson)).resolves.toBe('queued');
    expect(calls).toEqual(['/api/queue']);
    expect(output).not.toHaveBeenCalled();
  });

  it('reports a run with an output buffer as live', async () => {
    const { fetchJson, calls } = fakeFetch(queueOf([]), async () => ({ output: 'x' }));
    await expect(resolveReconnectPhase('run-a', fetchJson)).resolves.toBe('live');
    expect(calls).toEqual(['/api/queue', '/api/runs/run-a/output']);
  });

  it('reports a run unknown to the queue and the buffer as gone', async () => {
    const { fetchJson } = fakeFetch(queueOf([runRecord('run-other', 'pending')]), async () => {
      throw Object.assign(new Error('x'), { code: 'NOT_FOUND' });
    });
    await expect(resolveReconnectPhase('run-a', fetchJson)).resolves.toBe('gone');
  });

  it('rethrows a failure that is not a 404', async () => {
    const { fetchJson } = fakeFetch(queueOf([]), async () => {
      throw new Error('Network Error');
    });
    await expect(resolveReconnectPhase('run-a', fetchJson)).rejects.toThrow('Network Error');
  });
});

function fakeTerminal(): RunTerminal {
  return {
    writeln: vi.fn(),
    write: vi.fn(),
    clear: vi.fn(),
    fit: vi.fn(),
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    clearSearch: vi.fn(),
    ready: () => true,
  };
}

describe('useRunSessions', () => {
  beforeEach(() => {
    useRunSessions.setState(useRunSessions.getInitialState(), true);
    localStorage.clear();
    sessionStorage.clear();
  });

  it('keeps a field set before unmount for the next mount of the same session', () => {
    const first = renderHook(() => useSessionField('s1', 'selectedTags', [] as string[]));
    act(() => first.result.current[1](['@smoke', '@regression']));
    first.unmount();

    const second = renderHook(() => useSessionField('s1', 'selectedTags', [] as string[]));
    expect(second.result.current[0]).toEqual(['@smoke', '@regression']);
  });

  it('returns the initial value for a field never set', () => {
    const { result } = renderHook(() => useSessionField('s2', 'workers', 4));
    expect(result.current[0]).toBe(4);
  });

  it('keeps only the newest tail once the transcript passes the cap', () => {
    const { appendTranscript } = useRunSessions.getState();
    appendTranscript('s3', 'a'.repeat(OUTPUT_TAIL_LIMIT));
    appendTranscript('s3', 'END');
    const transcript = useRunSessions.getState().transcripts.s3 ?? '';
    expect(transcript.length).toBe(OUTPUT_TAIL_LIMIT);
    expect(transcript.endsWith('END')).toBe(true);
  });

  it('records what the wrapped terminal writes and resets on clear', () => {
    const term = fakeTerminal();
    const recorded = recordingTerminal(term, 's4');
    recorded.writeln('[Started]');
    recorded.write('chunk');
    expect(term.writeln).toHaveBeenCalledWith('[Started]');
    expect(term.write).toHaveBeenCalledWith('chunk');
    expect(useRunSessions.getState().transcripts.s4).toBe('[Started]\nchunk');
    recorded.clear();
    expect(term.clear).toHaveBeenCalled();
    expect(useRunSessions.getState().transcripts.s4).toBe('');
  });

  it('drops the form and the transcript of a removed session', () => {
    const state = useRunSessions.getState();
    state.setField('s5', 'project', 'my-project');
    state.appendTranscript('s5', 'out');
    useRunSessions.getState().removeSession('s5');
    expect(useRunSessions.getState().sessions.s5).toBeUndefined();
    expect(useRunSessions.getState().transcripts.s5).toBeUndefined();
  });

  it('writes nothing to web storage', () => {
    const state = useRunSessions.getState();
    state.setField('s6', 'silent', true);
    state.appendTranscript('s6', 'out');
    state.setTabs([{ id: 's6', status: 'running', project: 'my-project' }]);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
