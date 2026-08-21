import type { CustomCommand, RunRecord, RunRequest, RunStatus, WsServerEvent } from '@hub/shared';
import { nanoid } from 'nanoid';
import cron from 'node-cron';
import { buildTaskCommand } from './command-builder.js';
import { buildCustomCommand } from './custom-command-builder.js';
import { getEnabledToolIds } from './manifest-registry.js';
import { loadJson, saveJson } from './persistence.js';
import { runner } from './runner.js';

const SCHEDULES_FILE = 'schedules.json';

/**
 * Derive a human-readable failure reason for a `schedule-finished` event.
 * Only non-successful terminal outcomes carry a message; passed/skipped
 * return `undefined` so a success toast shows without extra text.
 */
function deriveFailureMessage(record: RunRecord): string | undefined {
  switch (record.status) {
    case 'failed':
      return typeof record.exitCode === 'number'
        ? `Run failed (exit code ${record.exitCode})`
        : 'Run failed';
    case 'cancelled':
      return 'Run cancelled';
    case 'error':
      return 'Run errored before completion';
    default:
      return undefined;
  }
}

export interface Schedule {
  id: string;
  name: string;
  cron: string;
  config: RunRequest;
  /**
   * Present ⇒ a CUSTOM schedule: the cron tick runs this shell command instead of
   * a tool run, and the enabled-tool gate is skipped. Absent ⇒ a tool run, which
   * behaves exactly as it did before this field existed.
   */
  command?: CustomCommand;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  /** Final status of the most recent triggered run (passed/failed/cancelled). */
  lastStatus?: RunStatus | 'pending';
  /** Run id of the most recent trigger — used to gate overlap firings. */
  lastRunId?: string;
  /**
   * When true, a cron tick that occurs while the previous run is still active
   * is skipped. Defaults to true. Stored on the schedule for forward-compat
   * but not yet exposed in the create form (always seeded `true`).
   */
  noOverlap?: boolean;
}

class SchedulerService {
  private schedules: Schedule[] = [];
  private tasks = new Map<string, ReturnType<typeof cron.schedule>>();
  /** Map runId → scheduleId so `run-finished` events update the right entry. */
  private runToSchedule = new Map<string, string>();
  private listenerAttached = false;

  constructor() {
    this.schedules = loadJson<Schedule[]>(SCHEDULES_FILE, []);
    this.attachListener();
    // Start all enabled schedules
    for (const s of this.schedules) {
      if (s.enabled) this.startTask(s);
    }
  }

  /**
   * Subscribe once to runner events so we can flip `lastStatus` to the real
   * final outcome (passed/failed/cancelled) instead of the initial 'pending'
   * that runner.start() returns.
   */
  private attachListener(): void {
    if (this.listenerAttached) return;
    this.listenerAttached = true;
    runner.on('event', (event: WsServerEvent) => {
      if (event.kind !== 'run-finished') return;
      // A run not bound to a schedule produces no schedule-finished event.
      const scheduleId = this.runToSchedule.get(event.runId);
      if (!scheduleId) return;
      this.runToSchedule.delete(event.runId);
      const schedule = this.schedules.find((s) => s.id === scheduleId);
      if (!schedule) return;
      schedule.lastStatus = event.record.status;
      this.persist();
      this.emitScheduleFinished(schedule, event.record);
    });
  }

  /**
   * Re-emit a `schedule-finished` event on the same runner event bus that
   * `ws.ts` subscribes to, so every connected client can surface a
   * Corner_Toast for the completed schedule. Only runs bound to a
   * schedule reach here — unbound runs never emit.
   */
  private emitScheduleFinished(schedule: Schedule, record: RunRecord): void {
    const message = deriveFailureMessage(record);
    const event: WsServerEvent = {
      kind: 'schedule-finished',
      runId: record.id,
      scheduleId: schedule.id,
      // Fall back to the schedule id when it has no name.
      scheduleName: schedule.name?.trim() ? schedule.name : schedule.id,
      status: record.status,
      silent: schedule.config.silent === true,
      ...(message !== undefined ? { message } : {}),
    };
    runner.emit('event', event);
  }

  getAll(): Schedule[] {
    return [...this.schedules];
  }

  get(id: string): Schedule | undefined {
    return this.schedules.find((s) => s.id === id);
  }

  create(name: string, cronExpr: string, config: RunRequest, command?: CustomCommand): Schedule {
    if (!cron.validate(cronExpr)) {
      throw new Error(`Invalid cron expression: ${cronExpr}`);
    }

    const schedule: Schedule = {
      id: nanoid(8),
      name,
      cron: cronExpr,
      config,
      // Spread so a tool schedule keeps NO `command` key at all, rather than an
      // explicit `undefined` that would be persisted as `"command": null`.
      ...(command ? { command } : {}),
      enabled: true,
      createdAt: new Date().toISOString(),
      noOverlap: true,
    };

    this.schedules.unshift(schedule);
    this.persist();
    this.startTask(schedule);
    return schedule;
  }

  update(
    id: string,
    updates: Partial<
      Pick<Schedule, 'name' | 'cron' | 'config' | 'command' | 'enabled' | 'noOverlap'>
    >,
  ): Schedule | null {
    const idx = this.schedules.findIndex((s) => s.id === id);
    if (idx === -1) return null;

    if (updates.cron && !cron.validate(updates.cron)) {
      throw new Error(`Invalid cron expression: ${updates.cron}`);
    }

    const schedule = this.schedules[idx] as Schedule;
    Object.assign(schedule, updates);
    this.persist();

    // Restart task with new config
    this.stopTask(id);
    if (schedule.enabled) this.startTask(schedule);

    return schedule;
  }

  delete(id: string): boolean {
    const idx = this.schedules.findIndex((s) => s.id === id);
    if (idx === -1) return false;

    this.stopTask(id);
    this.schedules.splice(idx, 1);
    this.persist();
    return true;
  }

  toggle(id: string): Schedule | null {
    const schedule = this.schedules.find((s) => s.id === id);
    if (!schedule) return null;

    schedule.enabled = !schedule.enabled;
    this.persist();

    if (schedule.enabled) {
      this.startTask(schedule);
    } else {
      this.stopTask(id);
    }

    return schedule;
  }

  /** True when this schedule's previous run is still active (running/pending). */
  private isPreviousRunActive(schedule: Schedule): boolean {
    if (!schedule.lastRunId) return false;
    return runner.getActive().some((r) => r.id === schedule.lastRunId);
  }

  private startTask(schedule: Schedule): void {
    this.stopTask(schedule.id);

    const task = cron.schedule(schedule.cron, async () => {
      // A custom schedule owns no tool, so the enabled-tool gate must be skipped
      // for it — checked FIRST, or every custom tick would be dropped silently.
      if (!schedule.command) {
        // Skip ticks for a disabled/uninstalled tool — the cron stays registered
        // so re-enabling the tool resumes firing without recreating the schedule.
        const enabledIds = await getEnabledToolIds();
        if (!enabledIds.has(schedule.config.tool)) {
          return;
        }
      }
      // Skip overlapping runs unless explicitly opted out.
      const noOverlap = schedule.noOverlap !== false;
      if (noOverlap && this.isPreviousRunActive(schedule)) {
        return;
      }
      schedule.lastRunAt = new Date().toISOString();
      const command = schedule.command
        ? buildCustomCommand(schedule.command)
        : await buildTaskCommand(schedule.config);
      const record = runner.start(schedule.config, command, 'schedule');
      schedule.lastRunId = record.id;
      schedule.lastStatus = 'pending';
      this.runToSchedule.set(record.id, schedule.id);
      this.persist();
    });

    this.tasks.set(schedule.id, task);
  }

  private stopTask(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      this.tasks.delete(id);
    }
  }

  private persist(): void {
    saveJson(SCHEDULES_FILE, this.schedules);
  }
}

export const scheduler = new SchedulerService();
