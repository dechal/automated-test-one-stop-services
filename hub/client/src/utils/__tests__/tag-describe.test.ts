import { describe, expect, it } from 'vitest';
import { describeTagQuery } from '~/utils/tag-describe.js';

describe('describeTagQuery', () => {
  it('keeps AND groups and OR members apart for a Playwright grep', () => {
    const expr =
      '(?=.*@e2e)(?=.*(?:@positive|@negative|@edge))(?!.*(?:@loop|@mobile|@TC-TADOM-401|@ci|@cancer))';
    expect(describeTagQuery('playwright', expr)).toEqual({
      include: [['@e2e'], ['@positive', '@negative', '@edge']],
      exclude: ['@loop', '@mobile', '@TC-TADOM-401', '@ci', '@cancer'],
    });
  });

  it('reads a Robot tag pattern', () => {
    expect(describeTagQuery('robot-framework', 'smokeANDuiORapiNOTslow')).toEqual({
      include: [['smoke'], ['ui', 'api']],
      exclude: ['slow'],
    });
  });

  it('returns a bare tag as a single include', () => {
    expect(describeTagQuery('playwright', '@smoke')).toEqual({
      include: [['@smoke']],
      exclude: [],
    });
  });
});
