import { buildTagGroups, classifyTag, TAG_KIND_ORDER } from '@hub/shared';
import { describe, expect, it } from 'vitest';

/**
 * Unit tests for the `@hub/shared` tag taxonomy — the single source of truth
 * for categorisation. They live in the server suite because `@hub/shared` has
 * no test runner of its own; vitest aliases `@hub/shared` to the package source
 * (see vitest.config.ts), so these exercise the real implementation.
 */

describe('classifyTag', () => {
  it('classifies facet tags (case-insensitive, tolerating an enum prefix)', () => {
    expect(classifyTag('@critical')).toBe('severity');
    expect(classifyTag('@Critical')).toBe('severity');
    expect(classifyTag('Severity.critical')).toBe('severity');
    expect(classifyTag('@e2e')).toBe('test-type');
    expect(classifyTag('@positive')).toBe('flow-type');
    expect(classifyTag('@edge')).toBe('flow-type');
    expect(classifyTag('@Edge')).toBe('flow-type');
    expect(classifyTag('@desktop')).toBe('device');
  });

  it('treats both `-C<digits>` and `TC-<UPPER>-<digits>` tags as case-ids', () => {
    expect(classifyTag('@TA_DOMESTIC-C001')).toBe('case-id');
    expect(classifyTag('@MOTOR_TYPE_1_MOBILE-C012')).toBe('case-id');
    expect(classifyTag('@TC-TADOM-001')).toBe('case-id');
    expect(classifyTag('@TC-LOGIN-001')).toBe('case-id');
    expect(classifyTag('TC-TAINT-205')).toBe('case-id');
  });

  it('classifies @rpa as a test-type facet', () => {
    expect(classifyTag('@rpa')).toBe('test-type');
  });

  it('keeps multi-test domain tags OUT of case-id (the regression)', () => {
    for (const tag of ['@ta', '@TA_HAPPY', '@TA_INTER_FAMILY_LOOP', '@MOTOR', '@TYPE1']) {
      expect(classifyTag(tag)).toBe('domain');
    }
  });
});

describe('buildTagGroups', () => {
  it('orders groups canonically and sorts tags by count desc then alpha', () => {
    const counts: Record<string, number> = {
      '@critical': 5,
      '@ta': 9,
      '@TA_HAPPY': 4,
      '@zzz-domain': 9,
      '@TA_DOMESTIC-C001': 1,
    };
    const groups = buildTagGroups(Object.keys(counts), (tag) => counts[tag] ?? 0);

    const kinds = groups.map((g) => g.kind);
    const canonical = [...kinds].sort(
      (a, b) => TAG_KIND_ORDER.indexOf(a) - TAG_KIND_ORDER.indexOf(b),
    );
    expect(kinds).toEqual(canonical);

    // Domain: count desc, then alpha for the 9/9 tie (@ta before @zzz-domain).
    const domain = groups.find((g) => g.kind === 'domain');
    expect(domain?.tags).toEqual(['@ta', '@zzz-domain', '@TA_HAPPY']);
  });

  it('splits single-test custom tags into the domain-single group', () => {
    const counts: Record<string, number> = {
      '@ta': 5, // multiple -> domain
      '@one-off': 1, // single   -> domain-single
      '@critical': 3, // facet
      '@FOO-C001': 1, // case-id
    };
    const groups = buildTagGroups(Object.keys(counts), (tag) => counts[tag] ?? 0);
    const tagsOf = (kind: string) => groups.find((g) => g.kind === kind)?.tags ?? [];

    expect(tagsOf('domain')).toEqual(['@ta']);
    expect(tagsOf('domain-single')).toEqual(['@one-off']);
    expect(tagsOf('case-id')).toEqual(['@FOO-C001']);
  });

  it('keeps domain tags together when no counts are available (fallback)', () => {
    const groups = buildTagGroups(['@ta', '@one-off']); // default countOf -> 0, no split
    expect(groups.find((g) => g.kind === 'domain')?.tags).toEqual(['@one-off', '@ta']);
    expect(groups.find((g) => g.kind === 'domain-single')).toBeUndefined();
  });
});
