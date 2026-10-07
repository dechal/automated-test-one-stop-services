import type { ToolId } from './tools.js';

// ===========================================================================
// Tag taxonomy — THE single source of truth for tag categorisation.
//
// Server (classification) and client (display order) both import from here so
// the Hub can never disagree with itself. Reporters live in separate pnpm
// workspaces and cannot import this module; they emit RAW test data and let
// the server classify. Any reporter-side grouping is display-only (their CLI
// pretty-print) and must mirror this file.
//
// Keep this framework-free (no Node / DOM) — see ./index.ts.
// ===========================================================================

/**
 * Stable category of a tag group. Drives classification, ordering and styling.
 * `case-id` is rendered last because case-ids are M:1 with tests (one test =
 * one case-id), unlike the other groups which are M:N filter facets.
 */
export type TagGroupKind =
  | 'severity'
  | 'test-type'
  | 'flow-type'
  | 'device'
  | 'domain'
  | 'domain-single'
  | 'case-id';

/**
 * Severity facet vocabulary — THE single source, ordered most→least severe.
 * The severity tag matcher and the severity-weighted score
 * (`./severity-score.ts`) both derive from this so they can never disagree.
 * Mirrors the spec-tag `Severity` enum (`@critical/@high/@medium/@low`).
 */
export const SEVERITY_LEVELS = ['critical', 'high', 'medium', 'low'] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

export interface TagCategory {
  kind: TagGroupKind;
  label: string;
  description: string;
  /** True when `tag` (with or without a leading `@`) belongs to this category. */
  match: (tag: string) => boolean;
}

/**
 * A "facet" matcher: a fixed vocabulary, case-insensitive, tolerating both the
 * bare form (`@critical`) and an enum-qualified form (`Severity.critical`).
 */
function facetMatcher(prefix: string, words: readonly string[]): (tag: string) => boolean {
  const re = new RegExp(`^@?(?:${prefix}\\.)?(?:${words.join('|')})$`, 'i');
  return (tag) => re.test(tag);
}

/**
 * Case-id matcher. A case-id is one of two canonical shapes (the only two the
 * id generator + spec authors produce):
 *   1. generated  — ends in `-C<digits>` (optional `-SUFFIX`/`_SUFFIX`), e.g.
 *      `TA_DOMESTIC-C001` (`getTestCaseId` / `generateTestCase` -> `C001`).
 *   2. explicit   — a `TC-<UPPER>-<digits>` doc id, e.g. `TC-TADOM-001`,
 *      `TC-LOGIN-001` (Playwright explicit `id`, Robot `TC-<DOMAIN>-NNN`).
 * This is intentionally strict: the old `/^@[A-Z]/` rule swallowed every
 * uppercase multi-test tag (`@TA_HAPPY`, `@MOTOR`, `@TA_INTER_FAMILY_LOOP`)
 * into Case ID, which is the bug this taxonomy fixes. The two reporters
 * (`tools/playwright/.../get-all-tag.ts`, `tools/robot-framework/.../GetAllTag.py`)
 * mirror this exact pattern — keep all three in sync.
 */
const CASE_ID_RE = /-C\d+(?:[-_][A-Za-z0-9]+)*$|^@?TC-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-\d+$/i;

/**
 * Ordered classification table. Order = match priority (first match wins).
 * The catch-all `domain` category is applied separately (see `classifyTag`)
 * so it never shadows a more specific match.
 */
export const TAG_TAXONOMY: readonly TagCategory[] = [
  {
    kind: 'severity',
    label: 'Severity',
    description: 'Priority level of the test case',
    match: facetMatcher('Severity', SEVERITY_LEVELS),
  },
  {
    kind: 'test-type',
    label: 'Test Type',
    description: 'Category of testing being performed',
    match: facetMatcher('TestType', [
      'functional',
      'e2e',
      'regression',
      'api',
      'security',
      'rpa',
      'loop',
    ]),
  },
  {
    kind: 'flow-type',
    label: 'Flow Type',
    description: 'Happy path vs. error handling',
    match: facetMatcher('TestFlowType', ['positive', 'negative', 'edge']),
  },
  {
    kind: 'device',
    label: 'Device',
    description: 'Target device viewport',
    match: facetMatcher('TestDevice', ['desktop', 'tablet', 'mobile']),
  },
  {
    kind: 'case-id',
    label: 'Case ID',
    description: 'Unique id selecting a single test',
    match: (tag) => CASE_ID_RE.test(tag),
  },
] as const;

/** Catch-all for project-specific feature / module / scenario tags. */
export const DOMAIN_CATEGORY: TagCategory = {
  kind: 'domain',
  label: 'Domain / Custom',
  description: 'Project-specific feature, module, or scenario tags',
  match: () => true,
};

/**
 * Display order of the groups: broad filter facets first, then the project
 * domain catch-all (split into multi-test then single-test), and the granular
 * per-test Case IDs last.
 */
export const TAG_KIND_ORDER: readonly TagGroupKind[] = [
  'severity',
  'test-type',
  'flow-type',
  'device',
  'domain',
  'domain-single',
  'case-id',
];

/**
 * Display label per kind. Facet labels come from the taxonomy; the domain
 * catch-all is split for display into a multi-test bucket and a single-test
 * bucket (see `buildTagGroups`).
 */
const KIND_LABEL = new Map<TagGroupKind, string>([
  ...TAG_TAXONOMY.map((cat) => [cat.kind, cat.label] as [TagGroupKind, string]),
  ['domain', 'Domain / Custom (multiple)'],
  ['domain-single', 'Domain / Custom (single)'],
]);

/** Classify a single tag into its category. Pure; never throws. */
export function classifyTag(tag: string): TagGroupKind {
  for (const cat of TAG_TAXONOMY) {
    if (cat.match(tag)) return cat.kind;
  }
  return DOMAIN_CATEGORY.kind;
}

/**
 * Decompose a stored Playwright grep expression back into individual tag
 * tokens. The Hub stores the BUILT grep expression in `run.request.tag` (see
 * the client's `buildTagExpr`), e.g. `(?=.*@critical)(?=.*(?:@C001|@C002))`.
 * Analytics / flaky detection must turn that back into
 * `['@critical', '@C001', '@C002']` — NOT naively split on `,`/`|`, which leaks
 * regex fragments like `(?=.*(?:@C001` into the UI (the bug this fixes).
 *
 * Handles both shapes `buildTagExpr` emits — single `(?=.*@x)` and OR-group
 * `(?=.*(?:@a|@b))`. A value that is not a lookahead expression (a bare tag a
 * user typed) is returned verbatim so saved bookmarks/schedules round-trip.
 * Pure; never throws. THE single source — both server (flaky) and client
 * and client (tag selection) import this.
 */
export function parseTagExpr(expr: string | undefined | null): string[] {
  return parseTagSelection(expr).include;
}

/** Tags a run selects, split by direction. Excluded tags must not run. */
export interface TagSelection {
  /** Tags that must match (AND across groups, OR within a group). */
  include: string[];
  /** Tags that must NOT match — any test carrying one is skipped. */
  exclude: string[];
}

/**
 * Decompose a stored grep expression into its include and exclude tags.
 *
 * This is the total parser: it reads BOTH shapes the builder emits, positive
 * `(?=.*…)` and negative `(?!.*…)`, in single and OR-group form. Reading only
 * the positives silently dropped every exclusion from a re-opened bookmark or
 * schedule — the run then covered more than the author saved — and an
 * exclude-only expression came back as a bogus tag literal (brain LESS-073).
 *
 * A value that is no lookahead expression at all (a bare tag a user typed) is
 * returned verbatim as an include, so hand-written values still round-trip.
 * Pure; never throws.
 */
export function parseTagSelection(expr: string | undefined | null): TagSelection {
  if (!expr) return { include: [], exclude: [] };
  // `(?=` / `(?!` then `.*`, then either an OR-group `(?:a|b)` or a single tag.
  const lookahead = /\((\?[=!])\.\*(?:\(\?:([^)]*)\)|([^)]+))\)/g;
  const include: string[] = [];
  const exclude: string[] = [];
  let matched = false;
  let m = lookahead.exec(expr);
  while (m !== null) {
    matched = true;
    const target = m[1] === '?!' ? exclude : include;
    const orGroup = m[2];
    const single = m[3];
    for (const part of (orGroup ?? single ?? '').split('|')) {
      const tag = part.trim();
      if (tag) target.push(tag);
    }
    m = lookahead.exec(expr);
  }
  if (!matched) return { include: [expr], exclude: [] };
  return { include: [...new Set(include)], exclude: [...new Set(exclude)] };
}

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

/** Group selected tags by the level that drives AND/OR semantics. */
export function groupByLevel(selected: readonly string[]): Map<TagLevel, string[]> {
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
 * Every emitted shape must stay readable by `parseTagSelection` here — the two
 * are a round-trip pair (brain LESS-073).
 */
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

/**
 * Group a flat tag list into ordered categories. Within each group, tags are
 * sorted by test count (descending) then alphabetically, so the tags covering
 * the most tests surface first. `countOf` is optional — when omitted (e.g. the
 * fallback path with no per-test data) groups fall back to alphabetical order
 * and the domain split is skipped (every domain tag stays in the multi-test
 * bucket, since coverage is unknown).
 */
export function buildTagGroups(
  tags: readonly string[],
  countOf: (tag: string) => number = () => 0,
): TagGroup[] {
  const buckets = new Map<TagGroupKind, string[]>();
  for (const tag of new Set(tags)) {
    let kind = classifyTag(tag);
    // Split the domain catch-all by coverage: a custom tag on exactly one test
    // ("no sub-tests") is more granular than one shared by many tests. A count
    // of 0 means no per-test data (fallback) — leave those in the multi bucket.
    if (kind === 'domain' && countOf(tag) === 1) kind = 'domain-single';
    const list = buckets.get(kind);
    if (list) list.push(tag);
    else buckets.set(kind, [tag]);
  }

  const groups: TagGroup[] = [];
  for (const kind of TAG_KIND_ORDER) {
    const list = buckets.get(kind);
    if (!list || list.length === 0) continue;
    list.sort((a, b) => countOf(b) - countOf(a) || a.localeCompare(b));
    groups.push({ kind, label: KIND_LABEL.get(kind) ?? kind, tags: list });
  }
  return groups;
}

export interface TagGroup {
  label: string;
  kind: TagGroupKind;
  tags: string[];
}

export interface TagDetailChild {
  tag: string;
  title: string;
}

export interface TagDetail {
  tag: string;
  count: number;
  tests: TagDetailChild[];
}

export interface TestSummary {
  id: string;
  title: string;
  tags: string[];
}

export interface TagsResponse {
  tool: ToolId;
  type: string;
  project: string;
  groups: TagGroup[];
  all: string[];
  details?: Record<string, TagDetail>;
  tests?: TestSummary[];
}
