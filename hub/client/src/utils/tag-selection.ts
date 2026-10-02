import { groupByLevel, type TestSummary } from '@hub/shared';

// ---------------------------------------------------------------------------
// Matching — AND between levels, OR within levels.
// ---------------------------------------------------------------------------

/**
 * Match tests against selection.
 * - AND between levels (must satisfy all selected levels)
 * - OR within a level (must satisfy at least one tag in that level)
 * - `excluded` wins over everything: a test carrying ANY excluded tag is out
 *
 * Exclusion deliberately ignores levels. "Don't run @flaky" means exactly that
 * whatever level `@flaky` sits in, so grouping it would only create ways for an
 * exclusion to be quietly satisfied by a sibling tag.
 *
 * Example: [@critical, @desktop, @DAIRY_CATTLE-C001, @DAIRY_CATTLE-C002]
 * -> tests that are (@critical) AND (@desktop) AND (C001 OR C002)
 */
export function matchTests(
  tests: TestSummary[],
  selected: string[],
  excluded: string[] = [],
): TestSummary[] {
  const kept =
    excluded.length === 0 ? tests : tests.filter((t) => !excluded.some((x) => t.tags.includes(x)));
  if (selected.length === 0) return kept;

  const byLevel = groupByLevel(selected);
  return kept.filter((t) => {
    for (const [, levelTags] of byLevel) {
      if (!levelTags.some((tag) => t.tags.includes(tag))) return false;
    }
    return true;
  });
}

export type { TagLevel, TagSelection } from '@hub/shared';
/**
 * Tag-expression primitives now live in `@hub/shared` (one source: the server
 * reuses them too), re-exported here so existing `~/utils/tag-selection`
 * importers keep working unchanged.
 */
export {
  buildTagExpr,
  buildTagQuery,
  getTagLevel,
  parseTagExpr,
  parseTagQuery,
  parseTagSelection,
} from '@hub/shared';
