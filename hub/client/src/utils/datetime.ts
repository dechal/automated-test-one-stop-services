import { dayjs } from './dayjs.js';

/**
 * Canonical run/report timestamp formatters.
 *
 * The History and Reports tables both render timestamps through these helpers
 * so the SAME instant always shows the SAME text everywhere. Reports are
 * aligned to history (the source of truth): the server now emits report
 * timestamps as ISO-8601 strings — identical in shape to a run's `startedAt`.
 *
 * All inputs are ISO-8601 strings; dayjs renders them in the viewer's local
 * timezone. A missing or unparseable value renders as `-` rather than the
 * literal "Invalid Date".
 */

/** Absolute local time, e.g. `2026-06-16 10:00:00`. */
export function formatAbsolute(iso: string | undefined | null): string {
  if (!iso) return '-';
  const d = dayjs(iso);
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm:ss') : '-';
}

export function formatShort(iso: string | undefined | null): string {
  if (!iso) return '-';
  const d = dayjs(iso);
  return d.isValid() ? d.format('DD MMM HH:mm') : '-';
}

export function formatDate(iso: string | undefined | null): string {
  if (!iso) return '-';
  const d = dayjs(iso);
  return d.isValid() ? d.format('DD MMM YYYY') : '-';
}

export function monthShortNames(): string[] {
  const start = dayjs().startOf('year');
  return Array.from({ length: 12 }, (_, i) => start.month(i).format('MMM'));
}

export function weekdayShortName(day: number): string {
  return dayjs().day(day).format('ddd');
}

/** Relative local time, e.g. `2 hours ago`. */
export function formatRelative(iso: string | number | undefined | null): string {
  if (!iso) return '-';
  const d = dayjs(iso);
  return d.isValid() ? d.fromNow() : '-';
}

/**
 * Compact duration from a millisecond span, e.g. `45s`, `3m 12s`, `2h 5m`.
 *
 * One implementation for every duration cell in the UI (History table, run-log
 * modal, Reports table) so the same span never renders two different ways.
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

/**
 * Compact duration between two ISO-8601 timestamps. A still-running entry has
 * no end timestamp, which renders as `-` rather than a bogus `0s`.
 */
export function formatDurationBetween(start: string, end?: string): string {
  if (!end) return '-';
  const from = dayjs(start);
  const to = dayjs(end);
  if (!from.isValid() || !to.isValid()) return '-';
  return formatDurationMs(to.diff(from));
}
