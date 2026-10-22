import { afterEach, describe, expect, it } from 'vitest';
import { formatNextRun, humanizeCron } from '~/utils/cron.js';
import {
  formatDate,
  formatDurationBetween,
  formatDurationMs,
  formatRelative,
  formatShort,
  monthShortNames,
  weekdayShortName,
} from '~/utils/datetime.js';
import { setDayjsLocale } from '~/utils/dayjs.js';

const THAI_SCRIPT = /[\u0E00-\u0E7F]/;

describe('formatShort / formatDate', () => {
  it('renders a placeholder for missing or unparseable input', () => {
    expect(formatShort(undefined)).toBe('-');
    expect(formatShort('not-a-date')).toBe('-');
    expect(formatDate(null)).toBe('-');
    expect(formatDate('not-a-date')).toBe('-');
  });

  it('formats a valid timestamp', () => {
    expect(formatDate('2026-07-27T10:00:00')).toBe('27 Jul 2026');
    expect(formatShort('2026-07-27T10:05:00')).toBe('27 Jul 10:05');
  });
});

describe('locale-aware formatting', () => {
  afterEach(() => {
    setDayjsLocale('en');
  });

  it('renders relative time in Thai once the dayjs locale is Thai', () => {
    setDayjsLocale('th');
    expect(formatRelative('2020-01-01T00:00:00.000Z')).toContain('ที่แล้ว');
  });

  it('names months and weekdays in the active locale', () => {
    expect(monthShortNames()).toHaveLength(12);
    expect(monthShortNames()[0]).toBe('Jan');
    expect(weekdayShortName(1)).toBe('Mon');
    setDayjsLocale('th');
    expect(monthShortNames()[0]).toMatch(THAI_SCRIPT);
    expect(weekdayShortName(1)).toMatch(THAI_SCRIPT);
  });

  it('humanises a cron expression in the requested locale', () => {
    expect(humanizeCron('0 1 * * 2', 'th')).toMatch(THAI_SCRIPT);
    expect(humanizeCron('0 1 * * 2', 'en')).not.toMatch(THAI_SCRIPT);
  });

  it('returns null for an invalid cron expression', () => {
    expect(humanizeCron('bad', 'en')).toBeNull();
    expect(formatNextRun('bad')).toBeNull();
  });

  it('describes the next fire time of a valid cron expression', () => {
    expect(formatNextRun('0 1 * * 2')).toMatch(/^in .+ \(\d{2} \w{3} 01:00\)$/);
  });
});

describe('formatDurationMs', () => {
  it('renders sub-minute spans in seconds', () => {
    expect(formatDurationMs(0)).toBe('0s');
    expect(formatDurationMs(45_000)).toBe('45s');
    expect(formatDurationMs(59_999)).toBe('59s');
  });

  it('renders minute spans with the remaining seconds', () => {
    expect(formatDurationMs(60_000)).toBe('1m 0s');
    expect(formatDurationMs(192_000)).toBe('3m 12s');
  });

  it('renders hour spans with the remaining minutes', () => {
    expect(formatDurationMs(3_600_000)).toBe('1h 0m');
    expect(formatDurationMs(7_500_000)).toBe('2h 5m');
  });

  it('renders a placeholder for unusable input', () => {
    expect(formatDurationMs(-1)).toBe('-');
    expect(formatDurationMs(Number.NaN)).toBe('-');
  });
});

describe('formatDurationBetween', () => {
  it('formats the span between two ISO timestamps', () => {
    expect(formatDurationBetween('2026-07-27T10:00:00.000Z', '2026-07-27T10:03:12.000Z')).toBe(
      '3m 12s',
    );
  });

  it('renders a placeholder while a run is still going', () => {
    expect(formatDurationBetween('2026-07-27T10:00:00.000Z')).toBe('-');
  });

  it('renders a placeholder for an unparseable timestamp', () => {
    expect(formatDurationBetween('not-a-date', '2026-07-27T10:00:00.000Z')).toBe('-');
  });
});
