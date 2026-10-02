import { parseTagSelection, type TagSelection, type TestSummary } from '@hub/shared';

// ---------------------------------------------------------------------------
// Tag levels — used for AND/OR semantics + Playwright grep expression.
//
// IMPORTANT: case-id is intentionally folded into the 'product' level so that
// `[@TA-C001, @cattle]` becomes "@TA-C001 OR @cattle" (run that specific TA
// test plus any cattle test) instead of an impossible AND constraint.
//
// 'loop' exists so loop tags can be found in their own picker group. It is a
// DISPLAY level only: for selection it folds back into 'product', because
// picking a loop case plus a domain case must still mean "run both" — an AND
// there matches nothing, which reads as a broken picker.
// ---------------------------------------------------------------------------

export type TagLevel = 'severity' | 'device' | 'flow' | 'test-type' | 'loop' | 'product';

const SEVERITY_TAGS = new Set(['@critical', '@high', '@medium', '@low']);
const DEVICE_TAGS = new Set(['@desktop', '@tablet', '@mobile']);
const FLOW_TAGS = new Set(['@positive', '@negative', '@edge']);
const TEST_TYPE_TAGS = new Set(['@functional', '@e2e', '@regression', '@api', '@security', '@rpa']);

/**
 * A loop tag carries LOOP as a whole `_`/`-` delimited segment — the two shapes
 * projects emit are `@<PREFIX>_LOOP` (multi-test, e.g. `@TA_INTER_FAMILY_LOOP`)
 * and `@<PREFIX>_LOOP-C<nnn>` (one case, e.g. `@TA_INTER_FAMILY_LOOP-C003`).
 * The rule is about the LOOP segment, never a project's prefix, so any project's
 * loop tags land here; a word that merely starts with it (`@LOOPBACK_AUTH`) does
 * not qualify.
 */
const LOOP_TAG_RE = /(?:^@?|[_-])LOOP(?:$|[_-])/i;

export function getTagLevel(tag: string): TagLevel {
  if (SEVERITY_TAGS.has(tag)) return 'severity';
  if (DEVICE_TAGS.has(tag)) return 'device';
  if (FLOW_TAGS.has(tag)) return 'flow';
  if (TEST_TYPE_TAGS.has(tag)) return 'test-type';
  if (LOOP_TAG_RE.test(tag)) return 'loop';
  return 'product'; // domain tags + case-ids share this level (OR)
}

/**
 * Level used for AND/OR semantics, where 'loop' collapses into 'product'. The
 * picker shows loop tags apart; selecting them behaves exactly as before, so a
 * loop case and a domain case still OR into one run.
 */
function selectionLevel(tag: string): TagLevel {
  const level = getTagLevel(tag);
  return level === 'loop' ? 'product' : level;
}

// ---------------------------------------------------------------------------
// Matching — AND between levels, OR within levels.
// ---------------------------------------------------------------------------

/** Group selected tags by the level that drives AND/OR semantics. */
function groupByLevel(selected: readonly string[]): Map<TagLevel, string[]> {
  const byLevel = new Map<TagLevel, string[]>();
  for (const tag of selected) {
    const level = selectionLevel(tag);
    const list = byLevel.get(level) ?? [];
    list.push(tag);
    byLevel.set(level, list);
  }
  return byLevel;
}

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

// ---------------------------------------------------------------------------
// Tag expression builder for Playwright grep.
// ---------------------------------------------------------------------------

/**
 * Build a Playwright-compatible grep expression.
 * AND between levels, OR within levels, plus one negative group for exclusions.
 *
 * Examples:
 *   [@critical] -> `(?=.*@critical)`
 *   [@critical, @desktop] -> `(?=.*@critical)(?=.*@desktop)`
 *   [@C001, @C002] -> `(?=.*(?:@C001|@C002))`
 *   exclude [@flaky] -> `(?!.*@flaky)` (appended, or alone when nothing is included)
 *
 * Every emitted shape must stay readable by `parseTagSelection` in
 * `@hub/shared` — the two are a round-trip pair (brain LESS-073).
 */
/**
 * Tag query for ONE tool, in that tool's own syntax.
 *
 * Playwright greps a regex; Robot Framework's `--include` takes a tag PATTERN and
 * rejects a regex outright — passing the Playwright form to Robot matched nothing
 * and was the pre-existing reason Hub-driven Robot tag filtering never worked.
 * Robot pattern operators are the documented compact spellings (`AND` / `OR` /
 * `NOT`, no surrounding spaces).
 *
 * Unknown tools fall back to the Playwright form, which is what the Hub has
 * always sent them.
 */
export function buildTagQuery(
  tool: string,
  selected: string[],
  excluded: string[] = [],
): string | undefined {
  return tool === 'robot-framework'
    ? buildRobotTagPattern(selected, excluded)
    : buildTagExpr(selected, excluded);
}

/**
 * Robot tag pattern: OR inside a level, AND across levels, one trailing NOT group
 * for the exclusions — the same semantics the Playwright emitter produces.
 */
function buildRobotTagPattern(selected: string[], excluded: string[]): string | undefined {
  const groups: string[] = [];
  for (const [, levelTags] of groupByLevel(selected)) {
    groups.push(levelTags.length === 1 ? (levelTags[0] as string) : levelTags.join('OR'));
  }
  const excl = [...new Set(excluded.filter((t) => t.trim() !== ''))];
  const includePart = groups.join('AND');
  const excludePart = excl.join('NOT');
  if (!includePart && !excludePart) return undefined;
  // A pattern that starts with NOT still needs something to subtract from, so an
  // exclude-only selection matches everything first.
  const head = includePart || '*';
  return excludePart ? `${head}NOT${excludePart}` : head;
}

export function buildTagExpr(selected: string[], excluded: string[] = []): string | undefined {
  const parts: string[] = [];

  for (const [, levelTags] of groupByLevel(selected)) {
    if (levelTags.length === 1) {
      parts.push(`(?=.*${levelTags[0]})`);
    } else {
      parts.push(`(?=.*(?:${levelTags.join('|')}))`);
    }
  }

  // One negative group for all exclusions — level-independent by design.
  const excl = [...new Set(excluded.filter((t) => t.trim() !== ''))];
  if (excl.length === 1) parts.push(`(?!.*${excl[0]})`);
  else if (excl.length > 1) parts.push(`(?!.*(?:${excl.join('|')}))`);

  return parts.length === 0 ? undefined : parts.join('');
}

/**
 * Inverse of {@link buildTagExpr}: decompose a saved grep expression back into a
 * flat list of tags, used when an edit/bookmark/schedule is re-opened. Now the
 * single source in `@hub/shared` (server flaky uses the same one),
 * re-exported here so existing `~/utils/tag-selection` importers keep working.
 */
export { parseTagExpr, parseTagSelection } from '@hub/shared';
export type { TagSelection };

/**
 * Round-trip partner of {@link buildTagQuery}: read a stored query back into its
 * include / exclude tags, in whichever syntax that tool uses.
 *
 * Both emitted shapes must be readable here or a re-opened bookmark silently
 * loses part of its selection (brain LESS-073).
 */
export function parseTagQuery(tool: string, expr: string | undefined | null): TagSelection {
  if (tool !== 'robot-framework') return parseTagSelection(expr);
  if (!expr) return { include: [], exclude: [] };
  const [includePart = '', ...excludeParts] = expr.split('NOT');
  const splitTags = (part: string): string[] =>
    part
      .split(/AND|OR/)
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '' && tag !== '*');
  return {
    include: [...new Set(splitTags(includePart))],
    exclude: [...new Set(excludeParts.flatMap(splitTags))],
  };
}
