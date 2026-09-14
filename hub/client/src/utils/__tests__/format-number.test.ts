import { describe, expect, it } from 'vitest';
import { formatCompactNumber, formatFullNumber } from '../format-number';

describe('formatCompactNumber', () => {
  it('leaves values under 1000 unabbreviated', () => {
    expect(formatCompactNumber(400)).toBe('400');
    expect(formatCompactNumber(0)).toBe('0');
  });

  it('abbreviates thousands with a lowercase k', () => {
    expect(formatCompactNumber(1000)).toBe('1k');
    expect(formatCompactNumber(1100)).toBe('1.1k');
    expect(formatCompactNumber(252000)).toBe('252k');
  });

  it('abbreviates millions with a lowercase m', () => {
    expect(formatCompactNumber(1000000)).toBe('1m');
    expect(formatCompactNumber(1224752)).toBe('1.2m');
  });

  it('returns a dash for non-finite input', () => {
    expect(formatCompactNumber(Number.NaN)).toBe('-');
    expect(formatCompactNumber(Number.POSITIVE_INFINITY)).toBe('-');
  });
});

describe('formatFullNumber', () => {
  it('groups digits with commas', () => {
    expect(formatFullNumber(1224752)).toBe('1,224,752');
    expect(formatFullNumber(400)).toBe('400');
  });

  it('returns a dash for non-finite input', () => {
    expect(formatFullNumber(Number.NaN)).toBe('-');
  });
});
