import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RunRequest, WsServerEvent } from '@hub/shared';
import fc from 'fast-check';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Silent run leaves no trace, regardless of terminal status.
 *
 * The runner spawns real child processes via `node:child_process.spawn`, which
 * is impractical to property-test across 100 runs. We therefore mock `spawn`
 * with a deterministic fake ChildProcess (a tiny EventEmitter exposing
 * `stdout` / `stderr` / `close` / `error`). That lets us drive ANY terminal
 * outcome — passed (close 0), failed (close non-zero), cancelled (close with
 * SIGINT/SIGTERM, which the runner classifies as cancelled), and error (the
 * child's `error` event) — without launching a process or touching the network.
 *
 * Every `runner.start(...)` → emit-terminal path runs synchronously: the
 * mocked spawn returns immediately and `child.emit('close'|'error', …)` fires
 * the runner's close/error handler in the same tick (the post-run webhook fire
 * short-circuits because no webhooks are configured in the in-memory DB).
 *
 * Isolation: `HUB_DB_PATH=':memory:'` is set before the runner/config modules
 * load (via `vi.hoisted`) and each test swaps in a fresh in-memory Local_DB via
 * `setDb`, so history / last-status / DB checks are fully isolated.
 */

const hoisted = vi.hoisted(() => {
  // Must run BEFORE config.ts/runner.ts load so LOCAL_DB_PATH resolves to an
  // ephemeral in-memory database rather than the real hub.db file.
  process.env.HUB_DB_PATH = ':memory:';

  type Listener = (...args: unknown[]) => void;

  /** Minimal synchronous EventEmitter sufficient for the runner's usage. */
  function makeEmitter() {
    const map = new Map<string, Listener[]>();
    return {
      on(event: string, cb: Listener) {
        const arr = map.get(event) ?? [];
        arr.push(cb);
        map.set(event, arr);
        return this;
      },
      emit(event: string, ...args: unknown[]) {
        const arr = map.get(event) ?? [];
        for (const cb of [...arr]) cb(...args);
        return arr.length > 0;
      },
    };
  }

  /** Fake ChildProcess: an emitter with `stdout`/`stderr` sub-emitters. */
  function makeFakeChild() {
    const child = makeEmitter() as ReturnType<typeof makeEmitter> & {
      stdout: ReturnType<typeof makeEmitter>;
      stderr: ReturnType<typeof makeEmitter>;
      pid: number;
      kill: () => boolean;
    };
    child.stdout = makeEmitter();
    child.stderr = makeEmitter();
    child.pid = 4242;
    child.kill = () => true;
    return child;
  }

  const spawnMock = vi.fn(() => makeFakeChild());
  return { spawnMock };
});

// Mock only `spawn`; keep every other `node:child_process` export real so any
// other module in the graph is unaffected.
vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return { ...actual, spawn: hoisted.spawnMock };
});

import { getDb, setDb } from '../db.js';
import { openLocalDb } from '../local-db.js';
import { runner } from '../runner.js';

// --- Terminal-outcome model -------------------------------------------------

type Outcome =
  | { kind: 'passed' }
  | { kind: 'failed'; code: number }
  | { kind: 'cancelled'; signal: 'SIGINT' | 'SIGTERM' }
  | { kind: 'error' };

const outcomeArb: fc.Arbitrary<Outcome> = fc.oneof(
  fc.constant<Outcome>({ kind: 'passed' }),
  fc.integer({ min: 1, max: 255 }).map<Outcome>((code) => ({ kind: 'failed', code })),
  fc
    .constantFrom<'SIGINT' | 'SIGTERM'>('SIGINT', 'SIGTERM')
    .map<Outcome>((signal) => ({ kind: 'cancelled', signal })),
  fc.constant<Outcome>({ kind: 'error' }),
);

const requestArb: fc.Arbitrary<RunRequest> = fc.record({
  tool: fc.constantFrom('playwright', 'robot-framework', 'k6'),
  type: fc.constantFrom('web', 'api', 'desktop', 'performance'),
  project: fc.constantFrom('alpha', 'beta', 'gamma', 'delta'),
  mode: fc.constantFrom('local', 'docker'),
});

/** Latest fake child created by the mocked spawn. */
function latestChild() {
  const result = hoisted.spawnMock.mock.results.at(-1);
  if (result?.type !== 'return') throw new Error('spawn was not called');
  return result.value as {
    stdout: { emit: (e: string, ...a: unknown[]) => boolean };
    stderr: { emit: (e: string, ...a: unknown[]) => boolean };
    emit: (e: string, ...a: unknown[]) => boolean;
  };
}

/** Emit some live output then drive the generated terminal outcome. */
function driveTerminal(child: ReturnType<typeof latestChild>, outcome: Outcome): void {
  // Output is emitted BEFORE the terminal event so the silent gate is
  // genuinely exercised — a silent run must stream none of it.
  child.stdout.emit('data', Buffer.from('stdout chunk'));
  child.stderr.emit('data', Buffer.from('stderr chunk'));
  if (outcome.kind === 'passed') child.emit('close', 0, null);
  else if (outcome.kind === 'failed') child.emit('close', outcome.code, null);
  else if (outcome.kind === 'cancelled') child.emit('close', null, outcome.signal);
  else child.emit('error', new Error('spawn failure'));
}

beforeEach(() => {
  // Fresh isolated in-memory DB + runner state for every test.
  setDb(openLocalDb(':memory:'));
  runner.clearHistory();
  hoisted.spawnMock.mockClear();
});

afterAll(async () => {
  // The runner creates `os.tmpdir()/hub-silent-<id>` for each silent run and
  // purges it asynchronously; sweep up any that linger after the suite.
  const dir = os.tmpdir();
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((n) => n.startsWith('hub-silent-'))
      .map((n) => fsp.rm(path.join(dir, n), { recursive: true, force: true }).catch(() => {})),
  );
});

describe('runner silent run no-trace invariants', () => {
  // Silent run leaves no trace, regardless of terminal status
  it('a silent run leaves no trace for any terminal status', () => {
    fc.assert(
      fc.property(requestArb, outcomeArb, (req, outcome) => {
        // Reset per iteration so the before-snapshot is deterministic.
        runner.clearHistory();
        const events: WsServerEvent[] = [];
        const listener = (e: WsServerEvent) => events.push(e);
        runner.on('event', listener);
        try {
          const historyBefore = runner.getHistory().length;
          const lastStatusBefore = JSON.stringify(runner.getLastStatusByProject());

          const rec = runner.start({ ...req, silent: true }, 'task test:run');
          driveTerminal(latestChild(), outcome);

          // history count unchanged and no record for this run id.
          expect(runner.getHistory().length).toBe(historyBefore);
          expect(runner.getHistory().some((r) => r.id === rec.id)).toBe(false);
          // the Local_DB history dataset has no row referencing the run id.
          const dbHistory = getDb().readCollection<{ id: string }>('history');
          expect(dbHistory.some((r) => r.id === rec.id)).toBe(false);

          // last-status index for the run's key is identical to before.
          expect(JSON.stringify(runner.getLastStatusByProject())).toBe(lastStatusBefore);

          // no stdout/stderr events were streamed for the silent run.
          const streamed = events.filter(
            (e) =>
              (e.kind === 'run-stdout' || e.kind === 'run-stderr') &&
              'runId' in e &&
              e.runId === rec.id,
          );
          expect(streamed.length).toBe(0);

          // the output buffer is purged once the run finishes.
          expect(runner.getOutputBuffer(rec.id)).toBeNull();
          // the run id is no longer in the active list.
          expect(runner.getActive().some((r) => r.id === rec.id)).toBe(false);
        } finally {
          runner.off('event', listener);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Sanity baseline: an IDENTICAL non-silent run DOES leave a trace, proving the
  // silent assertions above are not vacuously satisfied (silent parity).
  it('a non-silent run with the same outcomes does leave a trace (baseline)', () => {
    fc.assert(
      fc.property(requestArb, outcomeArb, (req, outcome) => {
        runner.clearHistory();
        const events: WsServerEvent[] = [];
        const listener = (e: WsServerEvent) => events.push(e);
        runner.on('event', listener);
        try {
          const before = runner.getHistory().length;

          const rec = runner.start({ ...req, silent: false }, 'task test:run');
          driveTerminal(latestChild(), outcome);

          // History grows by exactly one and contains this run (every terminal
          // status is recorded for a non-silent run).
          expect(runner.getHistory().length).toBe(before + 1);
          expect(runner.getHistory().some((r) => r.id === rec.id)).toBe(true);

          // Live output WAS streamed.
          const stdoutSeen = events.some(
            (e) => e.kind === 'run-stdout' && 'runId' in e && e.runId === rec.id,
          );
          const stderrSeen = events.some(
            (e) => e.kind === 'run-stderr' && 'runId' in e && e.runId === rec.id,
          );
          expect(stdoutSeen).toBe(true);
          expect(stderrSeen).toBe(true);
        } finally {
          runner.off('event', listener);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Concrete example covering.3's "previously HAD a value" branch: a silent
  // run for a key that already has a recorded last-status must not change it.
  it('silent run preserves a pre-existing last-status across every terminal status (example)', () => {
    const base: RunRequest = { tool: 'playwright', type: 'web', project: 'seeded', mode: 'local' };

    // Seed a non-silent run so the key has a last-status and one history row.
    {
      const rec = runner.start({ ...base, silent: false }, 'task test:run');
      driveTerminal(latestChild(), { kind: 'passed' });
      expect(runner.getHistory().some((r) => r.id === rec.id)).toBe(true);
    }
    const historyAfterSeed = runner.getHistory().length;
    const lastStatusAfterSeed = JSON.stringify(runner.getLastStatusByProject());
    expect(historyAfterSeed).toBe(1);

    const outcomes: Outcome[] = [
      { kind: 'passed' },
      { kind: 'failed', code: 2 },
      { kind: 'cancelled', signal: 'SIGINT' },
      { kind: 'error' },
    ];
    for (const outcome of outcomes) {
      const rec = runner.start({ ...base, silent: true }, 'task test:run');
      driveTerminal(latestChild(), outcome);

      expect(runner.getHistory().length).toBe(historyAfterSeed);
      expect(runner.getHistory().some((r) => r.id === rec.id)).toBe(false);
      expect(JSON.stringify(runner.getLastStatusByProject())).toBe(lastStatusAfterSeed);
      expect(runner.getOutputBuffer(rec.id)).toBeNull();
      expect(runner.getActive().some((r) => r.id === rec.id)).toBe(false);
    }
  });
});
