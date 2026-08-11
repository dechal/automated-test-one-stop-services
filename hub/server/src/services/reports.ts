import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ReportEntry, RunRecord, RunStatus, SeverityBreakdown, ToolId } from '@hub/shared';
import { OUTPUTS_DIR } from '../config.js';
import { historyStore } from './history-store.js';
import { getEnabledTools, getManifestModule } from './manifest-registry.js';
import { severityFromReportPath } from './severity-parse.js';

/**
 * Deterministic id for a report entry, derived from its absolute path. The
 * report list is rebuilt on every poll (10s cache); a random `nanoid` would
 * hand the client a new id for the same report each rebuild, churning React
 * keys and dropping the user's selection. The path is unique per report, so a
 * short content hash is stable across rebuilds and process restarts.
 */
function stableId(seed: string): string {
  return createHash('sha1').update(seed).digest('hex').slice(0, 12);
}

/**
 * Recursively walking `outputs/` is the slow part of every dashboard poll.
 * Cache the result for a short window and invalidate when reports are
 * created, deleted, or locked/unlocked.
 */
const REPORTS_CACHE_TTL_MS = 10_000;
let reportsCache: { value: ReportEntry[]; at: number } | null = null;

/**
 * Per-tool walk config resolved from the manifest registry. `typeAxis` decides
 * the `outputs/` directory shape (type axis vs flat), `type` is the report type
 * label for flat tools (e.g. k6 -> 'performance'), and `resultGlob` selects the
 * tool's result HTML file.
 */
interface ToolWalkConfig {
  readonly typeAxis: boolean;
  readonly type: string;
  readonly resultGlob: string;
}

/**
 * Resolve every enabled tool's walk config once. Mirrors the manifest-driven
 * scanner: a tool dir under `outputs/` is only scanned when it maps to a known
 * ENABLED manifest id; unknown/disabled dirs are skipped. The result glob comes
 * from `resolveCapabilities(manifest).reports.resultGlob`, which falls back to
 * the generic `**\/*.html` when the manifest declares no `reports` block.
 */
async function resolveToolWalkConfigs(): Promise<Map<string, ToolWalkConfig>> {
  const tools = await getEnabledTools();
  const mod = await getManifestModule();
  const byId = new Map<string, ToolWalkConfig>();
  for (const manifest of tools) {
    const { typeAxis, fixedType } = manifest.projects;
    const resultGlob = mod.resolveCapabilities(manifest).reports.resultGlob;
    byId.set(manifest.id, {
      typeAxis,
      type: fixedType ?? '',
      resultGlob,
    });
  }
  return byId;
}

async function buildAllEntries(): Promise<ReportEntry[]> {
  if (!fs.existsSync(OUTPUTS_DIR)) return [];
  const toolConfigs = await resolveToolWalkConfigs();
  const entries: ReportEntry[] = [];
  walkOutputs(OUTPUTS_DIR, toolConfigs, entries);
  attachSummaries(entries);
  attachSeverity(entries);
  return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Attach a per-severity tally to Playwright reports by reading the
 * `results.json` the JSON reporter writes into the run's time directory
 * (sibling of `html-results/`). Other tools have no per-test severity and are
 * left without a breakdown.
 */
function attachSeverity(entries: ReportEntry[]): void {
  for (const entry of entries) {
    if (entry.tool !== 'playwright') continue;
    const breakdown = severityFromReportPath(entry.reportPath);
    if (breakdown) entry.severity = breakdown;
  }
}

/** Report status ↔ run status compatibility, used to disambiguate two runs of
 * the same project that are close in time (e.g. a pass then a re-run failure). */
function statusCompatible(reportStatus: ReportEntry['status'], runStatus: RunStatus): boolean {
  if (reportStatus === 'success') return runStatus === 'passed';
  if (reportStatus === 'error') {
    return runStatus === 'failed' || runStatus === 'error' || runStatus === 'cancelled';
  }
  return true; // 'unknown' matches any
}

/**
 * Enrich each report with the test-case summary of the run that produced it.
 *
 * The runner persists `{passed, failed, skipped}` on every finished (non-silent)
 * run. There is no stored report↔run id, so we match on `tool/type/project`
 * plus time proximity: a report directory is stamped around run end, so the
 * report timestamp sits within (or right next to) the run's [startedAt, endedAt]
 * window. This is a heuristic — an old report whose run has aged out of the
 * capped history simply gets no summary, and two runs of the same project within
 * the match window resolve to the nearest. Advisory only — a failure to read
 * history leaves reports un-enriched rather than breaking the listing.
 */
function attachSummaries(entries: ReportEntry[]): void {
  let history: RunRecord[];
  try {
    history = historyStore.getAll();
  } catch {
    return; // enrichment is best-effort; never block the report listing
  }

  const byKey = new Map<string, RunRecord[]>();
  for (const r of history) {
    const key = `${r.request.tool}/${r.request.type}/${r.request.project}`;
    const list = byKey.get(key);
    if (list) list.push(r);
    else byKey.set(key, [r]);
  }
  if (byKey.size === 0) return;

  // Report time and run end can differ by clock rounding (legacy dirs omit
  // seconds) plus a little processing lag; 5 minutes covers that comfortably
  // while staying far below typical spacing between distinct runs.
  const MATCH_WINDOW_MS = 5 * 60_000;

  for (const e of entries) {
    const candidates = byKey.get(`${e.tool}/${e.type}/${e.project}`);
    if (!candidates) continue;
    const reportMs = Date.parse(e.timestamp);
    if (Number.isNaN(reportMs)) continue;

    let best: RunRecord | undefined;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const run of candidates) {
      if (!statusCompatible(e.status, run.status)) continue;
      const startMs = Date.parse(run.startedAt);
      const endMs = run.endedAt ? Date.parse(run.endedAt) : startMs;
      const dist =
        reportMs >= startMs && reportMs <= endMs
          ? 0
          : Math.min(Math.abs(reportMs - startMs), Math.abs(reportMs - endMs));
      if (dist < bestDist) {
        bestDist = dist;
        best = run;
      }
    }
    if (best && bestDist <= MATCH_WINDOW_MS) {
      if (best.summary) e.summary = best.summary;
      if (best.startedAt && best.endedAt) {
        const dMs = Date.parse(best.endedAt) - Date.parse(best.startedAt);
        if (!Number.isNaN(dMs) && dMs >= 0) e.durationMs = dMs;
      }
      if (best.request.tag) e.runTag = best.request.tag;
      e.runMode = best.request.mode;
    }
  }
}

/** Drop the cache so the next listReports call re-walks `outputs/`. */
export function invalidateReportsCache(): void {
  reportsCache = null;
}

/**
 * Map run id → the report entry that run produced.
 *
 * `RunRecord` carries no path to its output dir (`reportPath` is never written
 * by the runner), so history cannot locate its own `results.json`. The report
 * listing already knows the outputs layout, so we reverse the report↔run match
 * here — same tool/type/project + status + nearest-time-within-window heuristic
 * as `attachSummaries`. Best-effort: unmatched runs are simply absent.
 *
 * `filter` narrows which report entries are eligible (e.g. only entries that
 * already carry a severity breakdown), so a caller never matches a run to an
 * entry it cannot use.
 */
export async function reportEntryByRun(
  runs: RunRecord[],
  filter?: (entry: ReportEntry) => boolean,
): Promise<Map<string, ReportEntry>> {
  const result = new Map<string, ReportEntry>();
  if (runs.length === 0) return result;

  const entries = await listReports();
  const byKey = new Map<string, ReportEntry[]>();
  for (const e of entries) {
    if (filter && !filter(e)) continue;
    const key = `${e.tool}/${e.type}/${e.project}`;
    const list = byKey.get(key);
    if (list) list.push(e);
    else byKey.set(key, [e]);
  }
  if (byKey.size === 0) return result;

  const MATCH_WINDOW_MS = 5 * 60_000;
  for (const run of runs) {
    const candidates = byKey.get(`${run.request.tool}/${run.request.type}/${run.request.project}`);
    if (!candidates) continue;
    const startMs = Date.parse(run.startedAt);
    const endMs = run.endedAt ? Date.parse(run.endedAt) : startMs;

    let best: ReportEntry | undefined;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const e of candidates) {
      if (!statusCompatible(e.status, run.status)) continue;
      const reportMs = Date.parse(e.timestamp);
      if (Number.isNaN(reportMs)) continue;
      const dist =
        reportMs >= startMs && reportMs <= endMs
          ? 0
          : Math.min(Math.abs(reportMs - startMs), Math.abs(reportMs - endMs));
      if (dist < bestDist) {
        bestDist = dist;
        best = e;
      }
    }
    if (best && bestDist <= MATCH_WINDOW_MS) result.set(run.id, best);
  }
  return result;
}

/**
 * Map run id → severity breakdown, reusing {@link reportEntryByRun} and the
 * severity the report service already parsed — no second parse of `results.json`.
 */
export async function severityByRun(runs: RunRecord[]): Promise<Map<string, SeverityBreakdown>> {
  const matched = await reportEntryByRun(runs, (e) => !!e.severity);
  const result = new Map<string, SeverityBreakdown>();
  for (const [runId, entry] of matched) {
    if (entry.severity) result.set(runId, entry.severity);
  }
  return result;
}

/**
 * Recursively find HTML report files under outputs/.
 *
 * Output structure (type-axis tool):
 *   outputs/<tool>/<type>/<project>/<success|error>/<YYYY-MM-DD>/<HH-MM-SS>/<result>
 * Flat tool (e.g. k6, typeAxis=false):
 *   outputs/<tool>/<project>/<success|error>/<YYYY-MM-DD>/<HH-MM-SS>/<result>
 */
export async function listReports(filters?: {
  tool?: ToolId;
  type?: string;
  project?: string;
  status?: 'success' | 'error';
}): Promise<ReportEntry[]> {
  const now = Date.now();
  if (!reportsCache || now - reportsCache.at >= REPORTS_CACHE_TTL_MS) {
    reportsCache = { value: await buildAllEntries(), at: now };
  }
  const all = reportsCache.value;
  if (!filters) return [...all];
  return all.filter((e) => {
    if (filters.tool && e.tool !== filters.tool) return false;
    if (filters.type && e.type !== filters.type) return false;
    if (filters.project && e.project !== filters.project) return false;
    if (filters.status && e.status !== filters.status) return false;
    return true;
  });
}

function walkOutputs(
  baseDir: string,
  toolConfigs: Map<string, ToolWalkConfig>,
  out: ReportEntry[],
): void {
  for (const toolName of safeDirs(baseDir)) {
    // A tool dir is valid iff it maps to a known ENABLED manifest id. Unknown
    // and disabled tool dirs (and hidden dirs, via safeDirs) are skipped.
    const config = toolConfigs.get(toolName);
    if (!config) continue;

    const toolDir = path.join(baseDir, toolName);
    if (config.typeAxis) {
      walkTypeAxis(toolDir, toolName, config.resultGlob, out);
    } else {
      walkFlat(toolDir, toolName, config.type, config.resultGlob, out);
    }
  }
}

/** Type-axis tools: outputs/<tool>/<type>/<project>/… (Playwright, Robot). */
function walkTypeAxis(toolDir: string, tool: ToolId, resultGlob: string, out: ReportEntry[]): void {
  for (const type of safeDirs(toolDir)) {
    const typeDir = path.join(toolDir, type);
    for (const project of safeDirs(typeDir)) {
      const projDir = path.join(typeDir, project);
      findHtmlReports(projDir, tool, type, project, resultGlob, out);
    }
  }
}

/** Flat tools: outputs/<tool>/<project>/… with a fixed type (k6 -> performance). */
function walkFlat(
  toolDir: string,
  tool: ToolId,
  type: string,
  resultGlob: string,
  out: ReportEntry[],
): void {
  for (const project of safeDirs(toolDir)) {
    const projDir = path.join(toolDir, project);
    findHtmlReports(projDir, tool, type, project, resultGlob, out);
  }
}

function findHtmlReports(
  dir: string,
  tool: ToolId,
  type: string,
  project: string,
  resultGlob: string,
  out: ReportEntry[],
): void {
  // The manifest's `reports.resultGlob` selects the tool's result file:
  //   Playwright: **/html-results/index.html  (NOT trace/)
  //   Robot:      **/report.html
  //   k6:         **/summary.html
  //   unknown:    **/*.html                    (generic fallback)
  const htmlFiles = findFiles(dir, '.html').filter((f) => matchesGlob(f, resultGlob));
  for (const filePath of htmlFiles) {
    const rel = path.relative(dir, filePath).replace(/\\/g, '/');
    const parts = rel.split('/');

    const status = parts.includes('success')
      ? 'success'
      : parts.includes('error')
        ? 'error'
        : 'unknown';

    const { timestamp } = extractMeta(parts);

    out.push({
      id: stableId(filePath),
      tool,
      type,
      project,
      status: status as 'success' | 'error' | 'unknown',
      reportPath: filePath,
      timestamp,
      // A favourite is locked by definition, so the flag is derived here rather
      // than trusted from the marker files being in sync.
      locked: isLocked(filePath) || isFavorite(filePath),
      favorite: isFavorite(filePath),
    });
  }
}

/**
 * Minimal, dependency-free glob matcher for the report-result globs the
 * manifests emit: `**\/*.html`, `**\/report.html`, `**\/summary.html`,
 * `**\/html-results/index.html`. Supports a single leading `**` (matches any
 * number of leading path segments) followed by literal/`*` segments matched
 * against the path's trailing segments; `*` matches within a single segment.
 * This is intentionally not a general-purpose glob engine — adding minimatch /
 * picomatch just for these patterns is unjustified.
 */
function matchesGlob(filePath: string, glob: string): boolean {
  const segs = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const globSegs = glob.split('/').filter(Boolean);

  if (globSegs[0] === '**') {
    const tail = globSegs.slice(1);
    if (tail.length === 0) return true; // bare `**` matches anything
    if (segs.length < tail.length) return false;
    const start = segs.length - tail.length;
    return tail.every((g, i) => segmentMatches(segs[start + i] ?? '', g));
  }

  // No leading `**`: require an exact, full-length segment match.
  if (segs.length !== globSegs.length) return false;
  return globSegs.every((g, i) => segmentMatches(segs[i] ?? '', g));
}

/** Compiled wildcard-segment patterns, cached so a walk doesn't recompile the
 *  same glob segment RegExp for every candidate file. */
const segmentRegexCache = new Map<string, RegExp>();

function segmentMatches(segment: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return segment === pattern;
  let re = segmentRegexCache.get(pattern);
  if (!re) {
    re = new RegExp(`^${pattern.split('*').map(escapeRegex).join('[^/]*')}$`);
    segmentRegexCache.set(pattern, re);
  }
  return re.test(segment);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert a report directory's LOCAL wall-clock segments (`<YYYY-MM-DD>/<HH-MM-SS>`)
 * into an ISO-8601 instant, so every report carries the SAME timestamp shape as
 * a history record's `startedAt` (both ISO). History is the source of truth for
 * run times; aligning reports to it means the same run shows the same time — and
 * sorts chronologically.
 *
 * The segments are produced by the shell `date` command in the host's local
 * timezone, and the Hub server runs on that same host, so building a local
 * `Date` and calling `toISOString()` reconstructs the correct instant; the
 * browser then re-localizes it exactly as it does for history.
 *
 * The seconds segment is optional: legacy dirs emitted `HH-MM` (no seconds), so
 * a missing seconds field defaults to 0. An unparseable pair falls back to a
 * naive string so the entry still lists.
 */
function toIsoTimestamp(date: string, time: string): string {
  const [yStr, moStr, dStr] = date.split('-');
  const [hStr, mStr, sStr] = time.split('-');
  const year = Number(yStr);
  const month = Number(moStr);
  const day = Number(dStr);
  const hh = Number(hStr);
  const mm = Number(mStr);
  const ss = Number(sStr); // NaN when the segment omits seconds (legacy HH-MM)
  const valid =
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    Number.isInteger(hh) &&
    Number.isInteger(mm);
  if (valid)
    return new Date(year, month - 1, day, hh, mm, Number.isInteger(ss) ? ss : 0).toISOString();
  // Fallback: keep a naive string so the entry still shows.
  return `${date}T${time.replace(/-/g, ':')}`;
}

function extractMeta(parts: string[]): { timestamp: string } {
  let timestamp = '';

  const statusIdx = parts.findIndex((p) => p === 'success' || p === 'error');
  if (statusIdx >= 0 && parts.length > statusIdx + 2) {
    const date = parts[statusIdx + 1] ?? '';
    const time = parts[statusIdx + 2] ?? '';
    timestamp = toIsoTimestamp(date, time);
  }

  return { timestamp };
}

function findFiles(dir: string, ext: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const SKIP_DIRS = new Set(['.', 'node_modules', 'trace']);

  function walk(current: string): void {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
          walk(full);
        }
      } else if (entry.name.endsWith(ext)) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

function safeDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name);
}

/**
 * The run's time directory — the folder cleanup deletes, and where both the
 * `.lock` and `.favorite` markers live. `reportPath` is
 * `.../<time>/html-results/index.html`.
 */
function timeDirOf(reportPath: string): string {
  return path.dirname(path.dirname(reportPath));
}

/** Check if a report is locked (has .lock file in its time directory). */
function isLocked(reportPath: string): boolean {
  return fs.existsSync(path.join(timeDirOf(reportPath), '.lock'));
}

/** Check if a report is marked favourite (has .favorite file). */
export function isFavorite(reportPath: string): boolean {
  return fs.existsSync(path.join(timeDirOf(reportPath), '.favorite'));
}

/**
 * Mark a report as favourite. Writes the `.lock` marker too, so the protection
 * holds even if the favourite marker is later removed by hand — a favourite is
 * never an unprotected report.
 */
export function favoriteReport(reportPath: string): void {
  const timeDir = timeDirOf(reportPath);
  fs.writeFileSync(path.join(timeDir, '.favorite'), '', 'utf8');
  fs.writeFileSync(path.join(timeDir, '.lock'), '', 'utf8');
  invalidateReportsCache();
}

/**
 * Remove the favourite mark. The `.lock` stays: un-favouriting says "this is not
 * a keeper", not "delete it whenever" — the user can now unlock it explicitly.
 */
export function unfavoriteReport(reportPath: string): void {
  const favFile = path.join(timeDirOf(reportPath), '.favorite');
  if (fs.existsSync(favFile)) fs.unlinkSync(favFile);
  invalidateReportsCache();
}

/** Lock a report by creating a .lock file in its time directory. */
export function lockReport(reportPath: string): void {
  fs.writeFileSync(path.join(timeDirOf(reportPath), '.lock'), '', 'utf8');
  invalidateReportsCache();
}

/**
 * Unlock a report by removing the .lock file from its time directory.
 *
 * Refuses while the report is a favourite and reports it, rather than silently
 * doing nothing: the UI disables the control, but the route is reachable
 * directly and a favourite must never become deletable.
 */
export function unlockReport(reportPath: string): boolean {
  if (isFavorite(reportPath)) return false;
  const lockFile = path.join(timeDirOf(reportPath), '.lock');
  if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  invalidateReportsCache();
  return true;
}
