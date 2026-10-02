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
    match: facetMatcher('TestType', ['functional', 'e2e', 'regression', 'api', 'security', 'rpa']),
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
