import fs from 'node:fs';
import path from 'node:path';
import {
  emptySeverityBreakdown,
  type PneBreakdown,
  SEVERITY_LEVELS,
  type SeverityBreakdown,
  type SeverityLevel,
  type TestStatus,
} from '@hub/shared';

// ===========================================================================
// Single reader + deriver for a run's Playwright `results.json`.
//
// Every consumer that needs a run's per-test facts (severity tally, P/N/E
// breakdown, per-test outcomes) parses the file ONCE here and reads the derived
// values out of one cache, instead of each service re-reading and re-parsing
// the same (potentially large) JSON. The cache holds the DERIVED results, keyed
// by `path + mtimeMs + size`, so a re-run that rewrites the file in place
// (new mtime/size) re-derives, while a repeated read of the same file version
// is a map lookup.
//
// Best-effort: a missing / oversized / unparseable file yields a `null`-shaped
// result (every derived field `null`) rather than throwing — callers fall back
// to their own defaults.
// ===========================================================================

/** Per-test outcome extracted from a run's result file. */
export interface RunOutcome {
  key: string;
  title: string;
  file?: string;
  status: TestStatus;
  /** Playwright tags on the spec (includes cover tags like `TC-<docId>`). */
  tags?: string[];
  /** First line of the failure message, when the test failed. */
  error?: string;
  /** Artifact output directory basenames the reporter wrote for this spec. */
  artifactDirs?: string[];
  /** Spec line in its file, when the reporter recorded one. */
  line?: number;
}

/** Everything derived from one `results.json` in a single pass. */
export interface DerivedRunResults {
  severity: SeverityBreakdown | null;
  pne: PneBreakdown | null;
  outcomes: RunOutcome[] | null;
}

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

const MAX_RESULTS_JSON_BYTES = 25 * 1024 * 1024;
/** Max distinct file versions kept; oldest insertion evicted past this. */
export const RESULTS_CACHE_MAX_ENTRIES = 500;
const MAX_ERROR_CHARS = 500;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal colour codes from reporter output
const ANSI_RE = /\u001B\[[0-9;]*m/g;

const SEVERITY_SET = new Set<string>(SEVERITY_LEVELS);
const PNE_TOKENS = new Set<string>(['positive', 'negative', 'edge']);

function severityOf(tags: string[] | undefined): SeverityLevel | undefined {
  for (const raw of tags ?? []) {
    const tag = raw.replace(/^@/, '').toLowerCase();
    if (SEVERITY_SET.has(tag)) return tag as SeverityLevel;
  }
  return undefined;
}

/** P/N/E bucket for a spec file path (segment- or stem-exact token match). */
export function classifyPne(
  file: string | undefined,
): 'positive' | 'negative' | 'edge' | 'unclassified' {
  if (!file) return 'unclassified';
  const segments = file.replace(/\\/g, '/').split('/').filter(Boolean);
  for (const raw of segments) {
    const segment = raw.toLowerCase();
    if (PNE_TOKENS.has(segment)) return segment as 'positive' | 'negative' | 'edge';
    const stem = segment.split('.')[0] ?? '';
    if (PNE_TOKENS.has(stem)) return stem as 'positive' | 'negative' | 'edge';
  }
  return 'unclassified';
}

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

function artifactDirsOf(spec: PwSpec): string[] {
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
  return [...dirs];
}

interface Accumulator {
  severity: SeverityBreakdown;
  severityAny: boolean;
  pne: PneBreakdown;
  pneAny: boolean;
  outcomes: RunOutcome[];
}

/** Single recursive pass deriving severity + pne + outcomes from one suite. */
function walk(suite: PwSuite, fileHint: string | undefined, acc: Accumulator): void {
  const file = suite.file ?? fileHint;
  for (const spec of suite.specs ?? []) {
    acc.pneAny = true;
    acc.pne[classifyPne(file)] += 1;

    const level = severityOf(spec.tags);
    if (level) {
      acc.severityAny = true;
      if (spec.ok) acc.severity[level].passed += 1;
      else acc.severity[level].failed += 1;
    }

    const title = spec.title ?? '(untitled)';
    const key = spec.id || `${file ?? ''}::${title}`;
    const error = spec.ok ? undefined : firstErrorMessage(spec);
    const artifactDirs = artifactDirsOf(spec);
    acc.outcomes.push({
      key,
      title,
      file,
      status: spec.ok ? 'passed' : 'failed',
      tags: spec.tags ?? [],
      ...(error ? { error } : {}),
      ...(artifactDirs.length ? { artifactDirs } : {}),
      ...(spec.line ? { line: spec.line } : {}),
    });
  }
  for (const child of suite.suites ?? []) walk(child, file, acc);
}

const NULL_RESULTS: DerivedRunResults = { severity: null, pne: null, outcomes: null };

function derive(json: { suites?: PwSuite[] }): DerivedRunResults {
  const acc: Accumulator = {
    severity: emptySeverityBreakdown(),
    severityAny: false,
    pne: { positive: 0, negative: 0, edge: 0, unclassified: 0 },
    pneAny: false,
    outcomes: [],
  };
  for (const suite of json.suites ?? []) walk(suite, undefined, acc);
  return {
    severity: acc.severityAny ? acc.severity : null,
    pne: acc.pneAny ? acc.pne : null,
    outcomes: acc.outcomes,
  };
}

const cache = new Map<string, DerivedRunResults>();

function cacheGet(key: string): DerivedRunResults | undefined {
  return cache.get(key);
}

function cacheSet(key: string, value: DerivedRunResults): void {
  cache.set(key, value);
  while (cache.size > RESULTS_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Derive a run's results from the `results.json` beside its HTML report, once
 * per file version. `reportPath` is `.../<time>/html-results/index.html`; the
 * `results.json` sits in `<time>/` (the `json` reporter writes it there).
 *
 * Returns a fully-`null` {@link DerivedRunResults} when `reportPath` is absent
 * or the file is missing / oversized (> 25 MB) / unparseable.
 */
export function readRunResults(reportPath: string | undefined): DerivedRunResults {
  if (!reportPath) return NULL_RESULTS;
  const timeDir = path.dirname(path.dirname(reportPath));
  const resultsJsonPath = path.join(timeDir, 'results.json');

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resultsJsonPath);
  } catch {
    return NULL_RESULTS;
  }

  const key = `${resultsJsonPath}\u0000${stat.mtimeMs}\u0000${stat.size}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  let derived: DerivedRunResults = NULL_RESULTS;
  if (stat.size <= MAX_RESULTS_JSON_BYTES) {
    try {
      const json = JSON.parse(fs.readFileSync(resultsJsonPath, 'utf8')) as { suites?: PwSuite[] };
      derived = derive(json);
    } catch {
      derived = NULL_RESULTS;
    }
  }
  cacheSet(key, derived);
  return derived;
}

/** Drop every cached derivation — for tests that rewrite a fixture in place. */
export function invalidateResultsCache(): void {
  cache.clear();
}
