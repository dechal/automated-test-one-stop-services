import fs from 'node:fs';
import path from 'node:path';
import {
  type CompareCategory,
  type CompareRow,
  type CompareSide,
  classifyTag,
  type RunCompareResult,
  type RunRecord,
  type TestStatus,
} from '@hub/shared';

/** Minimal shape of the Playwright JSON reporter output we read. */
interface PwError {
  message?: string;
}
interface PwAttachment {
  name?: string;
  path?: string;
}
interface PwTestResult {
  error?: PwError;
  errors?: PwError[];
  /** Files the reporter wrote for this attempt (trace / video / screenshot). */
  attachments?: PwAttachment[];
}
interface PwTest {
  results?: PwTestResult[];
}
interface PwSpec {
  ok?: boolean;
  title?: string;
  id?: string;
  line?: number;
  tags?: string[];
  tests?: PwTest[];
}
interface PwSuite {
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}

/** One test's outcome, extracted from a run's result file. */
export interface RunOutcome {
  key: string;
  title: string;
  file?: string;
  status: TestStatus;
  /** Playwright tags on the spec (includes cover tags like `TC-<docId>`). */
  tags?: string[];
  /** First line of the failure message, when the test failed. */
  error?: string;
}

/** Max length of the failure summary we carry into a test-case doc cell. */
const MAX_ERROR_CHARS = 500;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal colour codes from reporter output
const ANSI_RE = /\u001B\[[0-9;]*m/g;

/**
 * First line of a failed spec's error message, stripped of ANSI colour codes and
 * capped — enough to fill a doc's "Actual Result" without pasting a whole stack.
 * Returns undefined when the reporter recorded no message.
 */
function firstErrorMessage(spec: PwSpec): string | undefined {
  for (const test of spec.tests ?? []) {
    for (const result of test.results ?? []) {
      const raw = result.error?.message ?? result.errors?.find((e) => e.message)?.message;
      if (!raw) continue;
      const line = raw.replace(ANSI_RE, '').split('\n')[0]?.trim();
      if (line) return line.slice(0, MAX_ERROR_CHARS);
    }
  }
  return undefined;
}

const MAX_RESULTS_JSON_BYTES = 25 * 1024 * 1024;

function collectOutcomes(suite: PwSuite, fileHint: string | undefined, out: RunOutcome[]): void {
  const file = suite.file ?? fileHint;
  for (const spec of suite.specs ?? []) {
    const title = spec.title ?? '(untitled)';
    // spec.id is a stable hash across runs of the same test; fall back to
    // file::title when a reporter omits it.
    const key = spec.id || `${file ?? ''}::${title}`;
    const error = spec.ok ? undefined : firstErrorMessage(spec);
    out.push({
      key,
      title,
      file,
      status: spec.ok ? 'passed' : 'failed',
      tags: spec.tags ?? [],
      ...(error ? { error } : {}),
    });
  }
  for (const child of suite.suites ?? []) collectOutcomes(child, file, out);
}

/**
 * Parse per-test outcomes from a run's Playwright `results.json` (written by the
 * `json` reporter into the run's time dir, sibling of `html-results/`).
 * `reportPath` is `.../<time>/html-results/index.html`; `results.json` sits in
 * `<time>/`. Best-effort: returns `null` when the path shape is unexpected or
 * the file is missing / oversized / unparseable.
 */
export function parseRunOutcomes(reportPath: string | undefined): RunOutcome[] | null {
  const json = readResultsJson(reportPath);
  if (!json) return null;
  const out: RunOutcome[] = [];
  for (const suite of json.suites ?? []) collectOutcomes(suite, undefined, out);
  return out;
}

/**
 * Read and parse a run's `results.json` (the `json` reporter writes it into the
 * run's time dir, sibling of `html-results/`). `reportPath` is
 * `.../<time>/html-results/index.html`.
 *
 * Single reader for every consumer so the size cap and the best-effort contract
 * are not re-implemented per call site. Returns `null` when the path shape is
 * unexpected or the file is missing / oversized / unparseable.
 */
function readResultsJson(reportPath: string | undefined): { suites?: PwSuite[] } | null {
  if (!reportPath) return null;
  const timeDir = path.dirname(path.dirname(reportPath));
  const resultsJsonPath = path.join(timeDir, 'results.json');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resultsJsonPath);
  } catch {
    return null;
  }
  if (stat.size > MAX_RESULTS_JSON_BYTES) return null;
  try {
    return JSON.parse(fs.readFileSync(resultsJsonPath, 'utf8')) as { suites?: PwSuite[] };
  } catch {
    return null;
  }
}

/** What the Hub can say about the test that produced an artifact directory. */
export interface ArtifactTestInfo {
  /** Spec title as authored, e.g. `MOTOR_TYPE_1-C001: รถยนต์ ประกันชั้น 1 …`. */
  title: string;
  /** Case-id tag when the spec carries one, else the `<id>:` title prefix. */
  caseId?: string;
  status: TestStatus;
  tags: string[];
  file?: string;
  line?: number;
}

/** A case id as a title prefix — `MOTOR_TYPE_1-C001: …`. Upper-case, no spaces. */
const TITLE_CASE_ID_RE = /^([A-Z0-9][A-Z0-9_-]*)\s*:/;

/**
 * Case id for a spec: prefer a real case-id TAG (authoritative, taxonomy-checked),
 * and fall back to the `<ID>:` prefix convention in the title so a spec that was
 * never tagged still reads as something other than a hash.
 */
function caseIdOf(title: string, tags: string[]): string | undefined {
  const tagged = tags.find((tag) => classifyTag(tag) === 'case-id');
  if (tagged) return tagged.replace(/^@/, '');
  return TITLE_CASE_ID_RE.exec(title)?.[1];
}

/**
 * Map each Playwright output directory to the test that produced it, so the Hub
 * can label an artifact folder with its case instead of showing the raw
 * `motorcycle-positive-Positi-7f22c-…-e2e` slug.
 *
 * The join key is the artifact directory BASENAME, taken from
 * `results.json` → `attachments[].path`. It must not be the full path: the
 * reporter records the pre-promotion `.temp/<date>/<time>/…` location while the
 * files the Hub serves live under the promoted `<status>/<date>/<time>/…`, so
 * comparing absolute paths never matches. The basename is identical in both.
 *
 * Nothing on disk is renamed — this is a display-time lookup only.
 * Best-effort: `null` when the run has no readable `results.json`.
 */
export function artifactTestIndex(
  reportPath: string | undefined,
): Record<string, ArtifactTestInfo> | null {
  const outcomes = parseArtifactOutcomes(reportPath);
  if (!outcomes) return null;
  const index: Record<string, ArtifactTestInfo> = {};
  for (const { dirs, info } of outcomes) {
    // First writer wins: a retried test reuses one directory, and the initial
    // attempt carries the same title.
    for (const dir of dirs) if (!index[dir]) index[dir] = info;
  }
  return index;
}

/** Per-spec artifact directories + display info, or `null` when unreadable. */
function parseArtifactOutcomes(
  reportPath: string | undefined,
): { dirs: string[]; info: ArtifactTestInfo }[] | null {
  const json = readResultsJson(reportPath);
  if (!json) return null;
  const out: { dirs: string[]; info: ArtifactTestInfo }[] = [];
  const walk = (suite: PwSuite, fileHint: string | undefined): void => {
    const file = suite.file ?? fileHint;
    for (const spec of suite.specs ?? []) {
      const title = spec.title ?? '(untitled)';
      const tags = spec.tags ?? [];
      const dirs = new Set<string>();
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          for (const attachment of result.attachments ?? []) {
            if (!attachment.path) continue;
            const dir = path.basename(path.dirname(attachment.path.replace(/\\/g, '/')));
            if (dir) dirs.add(dir);
          }
        }
      }
      if (dirs.size === 0) continue;
      out.push({
        dirs: [...dirs],
        info: {
          title,
          status: spec.ok ? 'passed' : 'failed',
          tags,
          ...(caseIdOf(title, tags) ? { caseId: caseIdOf(title, tags) } : {}),
          ...(file ? { file } : {}),
          ...(spec.line ? { line: spec.line } : {}),
        },
      });
    }
    for (const child of suite.suites ?? []) walk(child, file);
  };
  for (const suite of json.suites ?? []) walk(suite, undefined);
  return out;
}

/** What a "re-run only the failures" action can select from a finished run. */
export interface FailedSelection {
  /** Case-id tags of the failed tests — the selector a re-run greps on. */
  caseIds: string[];
  /** Titles of failed tests carrying no case-id tag, so they cannot be re-selected. */
  unidentified: string[];
  total: number;
  failed: number;
}

/**
 * Failed tests of a finished run, reduced to the case-id tags that can select
 * them again.
 *
 * Deliberately built from the run's own `results.json` rather than Playwright's
 * `--last-failed`: `.last-run.json` is deleted on every run by the output
 * promotion + `.temp` cleanup, so that flag can never work here (brain LESS-074).
 * Reading `results.json` also means ANY run in history can be re-run, not just
 * the most recent one.
 *
 * A failed test with no case-id tag is reported in `unidentified` instead of
 * being silently dropped — the caller can then say what it could not re-select.
 */
export function failedSelectionFromReport(reportPath: string | undefined): FailedSelection | null {
  const outcomes = parseRunOutcomes(reportPath);
  if (!outcomes) return null;
  const caseIds = new Set<string>();
  const unidentified: string[] = [];
  let failed = 0;
  for (const outcome of outcomes) {
    if (outcome.status !== 'failed') continue;
    failed++;
    const ids = (outcome.tags ?? []).filter((tag) => classifyTag(tag) === 'case-id');
    if (ids.length === 0) unidentified.push(outcome.title);
    else for (const id of ids) caseIds.add(id);
  }
  return { caseIds: [...caseIds].sort(), unidentified, total: outcomes.length, failed };
}

function emptyCounts(): Record<CompareCategory, number> {
  return { newlyFailed: 0, fixed: 0, stillFailing: 0, stillPassing: 0, added: 0, removed: 0 };
}

function categoryOf(a: TestStatus | undefined, b: TestStatus | undefined): CompareCategory {
  if (a && b) {
    if (a === 'passed' && b === 'failed') return 'newlyFailed';
    if (a === 'failed' && b === 'passed') return 'fixed';
    if (a === 'failed' && b === 'failed') return 'stillFailing';
    return 'stillPassing';
  }
  return a ? 'removed' : 'added';
}

// Most-actionable categories first (regressions surface at the top).
const CATEGORY_ORDER: CompareCategory[] = [
  'newlyFailed',
  'stillFailing',
  'fixed',
  'added',
  'removed',
  'stillPassing',
];

/**
 * Pure diff of two runs' per-test outcomes, matched across runs by the stable
 * {@link RunOutcome.key}. Rows are sorted with the most actionable categories
 * first, then by title.
 */
export function diffOutcomes(
  a: RunOutcome[],
  b: RunOutcome[],
): { rows: CompareRow[]; counts: Record<CompareCategory, number> } {
  const mapA = new Map(a.map((o) => [o.key, o]));
  const mapB = new Map(b.map((o) => [o.key, o]));
  const counts = emptyCounts();
  const rows: CompareRow[] = [];
  for (const key of new Set([...mapA.keys(), ...mapB.keys()])) {
    const oa = mapA.get(key);
    const ob = mapB.get(key);
    const category = categoryOf(oa?.status, ob?.status);
    counts[category] += 1;
    rows.push({
      key,
      title: ob?.title ?? oa?.title ?? key,
      file: ob?.file ?? oa?.file,
      category,
      a: oa?.status,
      b: ob?.status,
    });
  }
  rows.sort((x, y) => {
    const byCat = CATEGORY_ORDER.indexOf(x.category) - CATEGORY_ORDER.indexOf(y.category);
    return byCat !== 0 ? byCat : x.title.localeCompare(y.title);
  });
  return { rows, counts };
}

function tally(outcomes: RunOutcome[] | null): { total: number; passed: number; failed: number } {
  if (!outcomes) return { total: 0, passed: 0, failed: 0 };
  let passed = 0;
  for (const o of outcomes) if (o.status === 'passed') passed += 1;
  return { total: outcomes.length, passed, failed: outcomes.length - passed };
}

function toSide(run: RunRecord, t: { total: number; passed: number; failed: number }): CompareSide {
  return {
    runId: run.id,
    tool: run.request.tool,
    project: run.request.project,
    startedAt: run.startedAt,
    status: run.status,
    total: t.total,
    passed: t.passed,
    failed: t.failed,
  };
}

/** Compare two runs end-to-end into the client-facing DTO. */
export function compareRuns(runA: RunRecord, runB: RunRecord): RunCompareResult {
  const outcomesA = parseRunOutcomes(runA.reportPath);
  const outcomesB = parseRunOutcomes(runB.reportPath);
  const { rows, counts } = diffOutcomes(outcomesA ?? [], outcomesB ?? []);
  return {
    a: toSide(runA, tally(outcomesA)),
    b: toSide(runB, tally(outcomesB)),
    rows,
    counts,
    unavailable: outcomesA === null || outcomesB === null,
  };
}
