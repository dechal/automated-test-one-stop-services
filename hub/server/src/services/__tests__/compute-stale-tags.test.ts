import type { ToolId } from '@hub/shared';
import { describe, expect, it } from 'vitest';
import { computeStaleTags } from '../../routes/bookmarks.js';

const PW: ToolId = 'playwright';
const ROBOT: ToolId = 'robot-framework';

describe('computeStaleTags — Playwright expressions', () => {
  const projectTags = new Set(['@critical', '@desktop', '@DAIRY_CATTLE-C001']);

  it('returns [] when every referenced tag is present', () => {
    expect(computeStaleTags(PW, '(?=.*@critical)(?=.*@desktop)', projectTags)).toEqual([]);
  });

  it('reports only the tag that is gone', () => {
    expect(computeStaleTags(PW, '(?=.*@critical)(?=.*@gone)', projectTags)).toEqual(['@gone']);
  });

  it('reports every tag when all are gone', () => {
    expect(computeStaleTags(PW, '(?=.*@old)(?=.*@older)', projectTags).sort()).toEqual([
      '@old',
      '@older',
    ]);
  });

  it('returns [] for an undefined or empty expression', () => {
    expect(computeStaleTags(PW, undefined, projectTags)).toEqual([]);
    expect(computeStaleTags(PW, '', projectTags)).toEqual([]);
  });

  it('flags a stale tag inside an exclude group', () => {
    expect(computeStaleTags(PW, '(?!.*@gone)', projectTags)).toEqual(['@gone']);
  });
});

describe('computeStaleTags — Robot expressions (finding-2 regression)', () => {
  const projectTags = new Set(['@smoke', '@desktop', 'convert']);

  it('splits a Robot AND pattern instead of treating it as one bogus tag', () => {
    // Both @smoke and @desktop exist → not stale; the pattern must be split.
    expect(computeStaleTags(ROBOT, '@smokeAND@desktop', projectTags)).toEqual([]);
  });

  it('reports the one missing tag from a Robot OR/AND pattern', () => {
    expect(computeStaleTags(ROBOT, '@smokeAND@gone', projectTags)).toEqual(['@gone']);
  });

  it('flags a stale tag in a Robot NOT (exclude) segment', () => {
    expect(computeStaleTags(ROBOT, '@smokeNOT@gone', projectTags)).toEqual(['@gone']);
  });

  it('matches a bare project tag against an @-prefixed reference and vice versa', () => {
    // config references @convert; project emits bare `convert` → not stale.
    expect(computeStaleTags(ROBOT, '@convert', projectTags)).toEqual([]);
    // config references bare `smoke`; project emits @smoke → not stale.
    expect(computeStaleTags(ROBOT, 'smoke', projectTags)).toEqual([]);
  });
});
