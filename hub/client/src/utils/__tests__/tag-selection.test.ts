import type { TestSummary } from '@hub/shared';
import { describe, expect, it } from 'vitest';
import {
  buildTagExpr,
  buildTagQuery,
  matchTests,
  parseTagExpr,
  parseTagQuery,
} from '../tag-selection.js';

describe('buildTagExpr', () => {
  it('returns undefined for no selection', () => {
    expect(buildTagExpr([])).toBeUndefined();
  });

  it('emits a single lookahead for one tag', () => {
    expect(buildTagExpr(['@critical'])).toBe('(?=.*@critical)');
  });

  it('emits AND across levels (one lookahead each)', () => {
    expect(buildTagExpr(['@critical', '@desktop'])).toBe('(?=.*@critical)(?=.*@desktop)');
  });

  it('emits an OR-group for multiple same-level (case-id) tags', () => {
    expect(buildTagExpr(['@DAIRY_CATTLE-C001', '@DAIRY_CATTLE-C002'])).toBe(
      '(?=.*(?:@DAIRY_CATTLE-C001|@DAIRY_CATTLE-C002))',
    );
  });
});

describe('parseTagExpr — inverse of buildTagExpr', () => {
  it('returns [] for empty/undefined', () => {
    expect(parseTagExpr(undefined)).toEqual([]);
    expect(parseTagExpr('')).toEqual([]);
  });

  it('parses a single-tag lookahead', () => {
    expect(parseTagExpr('(?=.*@critical)')).toEqual(['@critical']);
  });

  it('parses an OR-group lookahead back into individual tags (the bug)', () => {
    expect(parseTagExpr('(?=.*(?:@DAIRY_CATTLE-C001|@DAIRY_CATTLE-C002))')).toEqual([
      '@DAIRY_CATTLE-C001',
      '@DAIRY_CATTLE-C002',
    ]);
  });

  it('parses a combined AND-of-levels expression', () => {
    expect(parseTagExpr('(?=.*@critical)(?=.*(?:@C001|@C002))')).toEqual([
      '@critical',
      '@C001',
      '@C002',
    ]);
  });

  it('preserves a non-lookahead value verbatim (back-compat)', () => {
    expect(parseTagExpr('@smoke')).toEqual(['@smoke']);
  });
});

describe('round-trip: parseTagExpr(buildTagExpr(x)) === x (order-independent)', () => {
  const cases: string[][] = [
    ['@critical'],
    ['@critical', '@desktop'],
    ['@DAIRY_CATTLE-C001', '@DAIRY_CATTLE-C002'],
    ['@critical', '@DAIRY_CATTLE-C001', '@DAIRY_CATTLE-C002'],
  ];
  for (const selected of cases) {
    it(`round-trips ${JSON.stringify(selected)}`, () => {
      const expr = buildTagExpr(selected);
      const parsed = parseTagExpr(expr);
      expect([...parsed].sort()).toEqual([...selected].sort());
    });
  }
});

describe('regression: a re-opened multi-case-id bookmark matches tests', () => {
  const tests: TestSummary[] = [
    { id: 'DAIRY_CATTLE-C001', title: 'case 1', tags: ['@DAIRY_CATTLE-C001', '@critical'] },
    { id: 'DAIRY_CATTLE-C002', title: 'case 2', tags: ['@DAIRY_CATTLE-C002', '@critical'] },
    { id: 'DAIRY_CATTLE-C003', title: 'case 3', tags: ['@DAIRY_CATTLE-C003', '@high'] },
  ];

  it('selecting two case-ids (via parsed bookmark) matches both, not zero', () => {
    const expr = '(?=.*(?:@DAIRY_CATTLE-C001|@DAIRY_CATTLE-C002))';
    const selected = parseTagExpr(expr);
    const matched = matchTests(tests, selected);
    expect(matched.map((t) => t.id).sort()).toEqual(['DAIRY_CATTLE-C001', 'DAIRY_CATTLE-C002']);
  });
});

describe('migrate round-trip: parse → drop stale → rebuild', () => {
  it('drops a stale tag from a Playwright expression and keeps the rest', () => {
    const { include, exclude } = parseTagQuery('playwright', '(?=.*@critical)(?=.*@gone)');
    const stale = new Set(['@gone']);
    const rebuilt = buildTagQuery(
      'playwright',
      include.filter((t) => !stale.has(t)),
      exclude.filter((t) => !stale.has(t)),
    );
    expect(parseTagQuery('playwright', rebuilt).include).toEqual(['@critical']);
  });

  it('collapses a Playwright expression to undefined when every tag is stale', () => {
    const { include, exclude } = parseTagQuery('playwright', '(?=.*@gone)(?=.*@older)');
    const stale = new Set(['@gone', '@older']);
    const rebuilt = buildTagQuery(
      'playwright',
      include.filter((t) => !stale.has(t)),
      exclude.filter((t) => !stale.has(t)),
    );
    expect(rebuilt).toBeUndefined();
  });

  it('drops a stale tag from a Robot pattern and keeps the rest', () => {
    const { include, exclude } = parseTagQuery('robot-framework', '@smokeAND@gone');
    const stale = new Set(['@gone']);
    const rebuilt = buildTagQuery(
      'robot-framework',
      include.filter((t) => !stale.has(t)),
      exclude.filter((t) => !stale.has(t)),
    );
    expect(rebuilt).toBe('@smoke');
  });

  it('collapses a Robot pattern to undefined when every tag is stale', () => {
    const { include, exclude } = parseTagQuery('robot-framework', '@goneAND@older');
    const stale = new Set(['@gone', '@older']);
    const rebuilt = buildTagQuery(
      'robot-framework',
      include.filter((t) => !stale.has(t)),
      exclude.filter((t) => !stale.has(t)),
    );
    expect(rebuilt).toBeUndefined();
  });
});
