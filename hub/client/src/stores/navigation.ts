import type {
  HeadlessMode,
  PerformanceType,
  QueueStatus,
  RunMode,
  RunRequest,
  RunStatus,
  RunSummary,
  ToolId,
} from '@hub/shared';
import { useCallback } from 'react';
import { create } from 'zustand';
import type { RunTerminal } from '~/hooks/useRunTerminal.js';

/**
 * Cross-route navigation state.
 * Holds ephemeral data that needs to survive route transitions
 * (e.g. quick-run config passed from Dashboard/Spotlight → Run page).
 */
interface NavigationStore {
  pendingRunConfig: RunRequest | null;
  setPendingRunConfig: (config: RunRequest | null) => void;
  consumePendingRunConfig: () => RunRequest | null;
}

export const useNavigationStore = create<NavigationStore>()((set, get) => ({
  pendingRunConfig: null,
  setPendingRunConfig: (config) => set({ pendingRunConfig: config }),
  consumePendingRunConfig: () => {
    const config = get().pendingRunConfig;
    set({ pendingRunConfig: null });
    return config;
  },
}));

export const OUTPUT_TAIL_LIMIT = 512 * 1024;

export function appendCapped(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= OUTPUT_TAIL_LIMIT ? next : next.slice(-OUTPUT_TAIL_LIMIT);
}

export type ReconnectPhase = 'queued' | 'live' | 'gone';

export type FetchJson = <T>(path: string) => Promise<T>;

export async function resolveReconnectPhase(
  runId: string,
  fetchJson: FetchJson,
): Promise<ReconnectPhase> {
  const queue = await fetchJson<QueueStatus>('/api/queue');
  if (queue.queued.some((record) => record.id === runId)) return 'queued';
  try {
    await fetchJson<{ output: string }>(`/api/runs/${runId}/output`);
    return 'live';
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'NOT_FOUND') return 'gone';
    throw error;
  }
}

export interface SessionTab {
  id: string;
  status: RunStatus | 'idle';
  project: string;
  tool?: ToolId;
  initialConfig?: RunRequest;
  reconnectRunId?: string;
  reconnectCommand?: string;
}

export interface RunSessionState {
  tool: ToolId;
  mode: RunMode;
  type: string;
  project: string;
  envProfileId: string;
  envDefaultFor: string;
  selectedTags: string[];
  excludedTags: string[];
  headless: HeadlessMode;
  extraArgs: string;
  workers: number | null;
  repeatEach: number | null;
  noTrack: boolean;
  silent: boolean;
  discardReport: boolean;
  autoOpenReport: boolean;
  section: string;
  perfType: PerformanceType;
  runStatus: RunStatus | 'idle';
  activeRunId: string | null;
  lastCommand: string;
  startTime: number | null;
  elapsed: string;
  runSummary: RunSummary | null;
  lastRequest: RunRequest | null;
}

interface RunSessionsStore {
  initialized: boolean;
  tabs: SessionTab[];
  activeId: string;
  sessions: Record<string, Partial<RunSessionState>>;
  transcripts: Record<string, string>;
  setTabs: (next: SessionTab[] | ((prev: SessionTab[]) => SessionTab[])) => void;
  setActiveId: (id: string) => void;
  markInitialized: () => void;
  setField: <K extends keyof RunSessionState>(
    id: string,
    key: K,
    value: RunSessionState[K],
  ) => void;
  appendTranscript: (id: string, chunk: string) => void;
  resetTranscript: (id: string) => void;
  removeSession: (id: string) => void;
}

function withoutKey<T>(record: Record<string, T>, id: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== id));
}

export const useRunSessions = create<RunSessionsStore>()((set) => {
  const id = crypto.randomUUID();
  return {
    initialized: false,
    tabs: [{ id, status: 'idle', project: '' }],
    activeId: id,
    sessions: {},
    transcripts: {},
    setTabs: (next) => set((s) => ({ tabs: typeof next === 'function' ? next(s.tabs) : next })),
    setActiveId: (activeId) => set({ activeId }),
    markInitialized: () => set({ initialized: true }),
    setField: (sessionId, key, value) =>
      set((s) => {
        const current = s.sessions[sessionId];
        if (current && key in current && Object.is(current[key], value)) return s;
        return { sessions: { ...s.sessions, [sessionId]: { ...current, [key]: value } } };
      }),
    appendTranscript: (sessionId, chunk) =>
      set((s) => ({
        transcripts: {
          ...s.transcripts,
          [sessionId]: appendCapped(s.transcripts[sessionId] ?? '', chunk),
        },
      })),
    resetTranscript: (sessionId) =>
      set((s) => ({ transcripts: { ...s.transcripts, [sessionId]: '' } })),
    removeSession: (sessionId) =>
      set((s) => ({
        sessions: withoutKey(s.sessions, sessionId),
        transcripts: withoutKey(s.transcripts, sessionId),
      })),
  };
});

export function useSessionField<K extends keyof RunSessionState>(
  sessionId: string,
  key: K,
  initial: RunSessionState[K],
): [RunSessionState[K], (value: RunSessionState[K]) => void] {
  const stored = useRunSessions((s) => s.sessions[sessionId]?.[key]);
  const setField = useRunSessions((s) => s.setField);
  const setValue = useCallback(
    (value: RunSessionState[K]) => setField(sessionId, key, value),
    [setField, sessionId, key],
  );
  return [stored === undefined ? initial : (stored as RunSessionState[K]), setValue];
}

export function recordingTerminal(term: RunTerminal, sessionId: string): RunTerminal {
  const { appendTranscript, resetTranscript } = useRunSessions.getState();
  return {
    ...term,
    write: (chunk) => {
      term.write(chunk);
      appendTranscript(sessionId, chunk);
    },
    writeln: (line) => {
      term.writeln(line);
      appendTranscript(sessionId, `${line}\n`);
    },
    clear: () => {
      term.clear();
      resetTranscript(sessionId);
    },
  };
}
