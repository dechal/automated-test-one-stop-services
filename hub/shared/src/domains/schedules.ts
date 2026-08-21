import type { RunRequest, RunStatus } from './runs.js';

/**
 * A schedule that runs a plain shell command instead of a tool test run — a seed
 * script, a cleanup, a `.bat`, a `git pull`.
 *
 * Additive by design: when `ScheduleEntry.command` is absent the entry is a tool
 * run and behaves exactly as before, so an existing `schedules.json` stays valid
 * with no migration.
 */
export interface CustomCommand {
  /** The executable or script to run, e.g. `node scripts/seed.mjs` or `task lint`. */
  script: string;
  /** Extra arguments, appended verbatim. */
  args?: string;
  /** Working directory, relative to the workspace root. Must stay inside it. */
  cwd?: string;
}

export interface ScheduleEntry {
  id: string;
  name: string;
  cron: string;
  /**
   * Tool-run parameters. Still required for a custom schedule (it carries the
   * project label the history and schedule list render), but the command itself
   * comes from {@link ScheduleEntry.command} when that is set.
   */
  config: RunRequest;
  /** Present ⇒ this is a CUSTOM schedule; absent ⇒ a tool run, as before. */
  command?: CustomCommand;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  /** Outcome of the most recent run; 'pending' while a run is in flight. */
  lastStatus?: RunStatus | 'pending';
  nextRunAt?: string;
}
