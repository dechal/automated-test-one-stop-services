#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ID_HEADER = 'Test Case ID';
const STATUS_HEADER = 'Status';
const ACTUAL_RESULT_HEADER = 'Actual Result';
const UPDATED_AT_HEADER = 'Updated At';
const EDITED_BY_HEADER = 'Edited By';
const OVERLAY_SUFFIX = '.edited.json';
const DOC_RE = /test[-_ ]?cases?.*\.xlsx$/i;
const RESULT_SUFFIX = '.result.xlsx';
const TC_RE = /^(TC-[A-Z0-9]+-\d{3,})/;
const HISTORY_LIMIT = 50;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTPUTS_DIR = path.join(ROOT, 'outputs');
const TOOLS_DIR = path.join(ROOT, 'tools');

/** @typedef {{ rows: string[][] }} Sheet */
/** @typedef {{ status: 'passed' | 'failed', error?: string }} RunResult */
/** @typedef {{ id: string, name: string }} Author */
/** @typedef {{ cellStamp?: string, author?: Author, editors?: Record<string, string> }} ApplyOptions */
/** @typedef {{ author?: Author, editors?: Record<string, string>, runAt?: string }} SyncOptions */
/** @typedef {{ status: string, durationMs: number | null, error?: string }} Verdict */
/** @typedef {{ tool: string, type: string, project: string }} ProjectMeta */
/** @typedef {{ duration?: number, status?: string, error?: { message?: string } }} PwResult */
/** @typedef {{ title?: string, tests?: { results?: PwResult[] }[] }} PwSpec */
/** @typedef {{ specs?: PwSpec[], suites?: PwSuite[] }} PwSuite */
/** @typedef {{ status: string, durationMs: number | null, lastRun: string }} CaseEntry */
/** @typedef {{ cases?: Record<string, CaseEntry>, history?: unknown[] }} StatusFile */

/**
 * @param {string[]} header
 * @param {string} name
 */
function headerIndex(header, name) {
  return header.findIndex((h) => String(h).trim().toLowerCase() === name.toLowerCase());
}

export function stampNow(at = new Date()) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `${date} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * @param {Sheet[]} sheets
 * @param {Record<string, RunResult>} resultByCaseId
 * @param {ApplyOptions} [options]
 */
export function applyRunResults(sheets, resultByCaseId, options = {}) {
  const { cellStamp = stampNow(), author, editors: previous = {} } = options;
  const editors = { ...previous };
  let matched = 0;
  let total = 0;
  for (const [sheetIdx, sheet] of sheets.entries()) {
    const header = sheet.rows[0] ?? [];
    const idIdx = headerIndex(header, ID_HEADER);
    const statusIdx = headerIndex(header, STATUS_HEADER);
    if (idIdx < 0 || statusIdx < 0) continue;
    const uaIdx = headerIndex(header, UPDATED_AT_HEADER);
    const actualIdx = headerIndex(header, ACTUAL_RESULT_HEADER);
    const ebIdx = author ? headerIndex(header, EDITED_BY_HEADER) : -1;
    for (let r = 1; r < sheet.rows.length; r++) {
      const row = sheet.rows[r];
      if (!row) continue;
      total++;
      const id = (row[idIdx] ?? '').trim();
      const outcome = id ? resultByCaseId[id] : undefined;
      if (!outcome) continue;
      const widest = Math.max(statusIdx, uaIdx, actualIdx, ebIdx);
      while (row.length <= widest) row.push('');
      row[statusIdx] = outcome.status === 'passed' ? 'Pass' : 'Fail';
      if (actualIdx >= 0) row[actualIdx] = outcome.status === 'failed' ? (outcome.error ?? '') : '';
      if (uaIdx >= 0) row[uaIdx] = cellStamp;
      if (author && ebIdx >= 0) {
        row[ebIdx] = author.name;
        editors[`${sheetIdx}:${r}`] = author.id;
      }
      matched++;
    }
  }
  return { matched, total, editors };
}

/**
 * @param {string} docPath
 * @param {Sheet[]} sheets
 * @param {{ editors?: Record<string, string>, lastRunAt?: string }} extra
 */
export function writeRunOverlay(docPath, sheets, { editors, lastRunAt }) {
  const payload = {
    source: path.basename(docPath),
    savedAt: new Date().toISOString(),
    sheets,
    ...(editors && Object.keys(editors).length > 0 ? { editors } : {}),
    ...(lastRunAt ? { lastRunAt } : {}),
  };
  fs.writeFileSync(`${docPath}${OVERLAY_SUFFIX}`, JSON.stringify(payload, null, 2), 'utf8');
}

/**
 * @param {string} docPath
 * @param {Sheet[]} sheets
 * @param {Record<string, RunResult>} resultByCaseId
 * @param {SyncOptions} [options]
 */
export function syncRunToDoc(docPath, sheets, resultByCaseId, options = {}) {
  const at = new Date();
  const applied = applyRunResults(sheets, resultByCaseId, {
    cellStamp: stampNow(at),
    author: options.author,
    editors: options.editors,
  });
  if (applied.matched > 0) {
    writeRunOverlay(docPath, sheets, {
      editors: applied.editors,
      lastRunAt: options.runAt ?? at.toISOString(),
    });
  }
  return { matched: applied.matched, total: applied.total };
}

/** @param {string | undefined} name */
function extractTcId(name) {
  const m = String(name).match(TC_RE);
  return m ? m[1] : null;
}

/** @param {string} text */
function parseRobot(text) {
  /** @type {Map<string, Verdict>} */
  const out = new Map();
  const testBlock = /<test\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/test>/g;
  /** @type {Record<string, string>} */
  const verdicts = { PASS: 'Pass', FAIL: 'Fail', SKIP: 'Skipped' };
  for (const m of text.matchAll(testBlock)) {
    const tcId = extractTcId(m[1]);
    if (!tcId) continue;
    const statuses = [
      ...(m[2] ?? '').matchAll(
        /<status\b[^>]*\bstatus="([A-Z]+)"[^>]*?(?:\/>|>([\s\S]*?)<\/status>)/g,
      ),
    ];
    const last = statuses.at(-1);
    if (!last) continue;
    const error = last[2]?.trim().split('\n')[0];
    out.set(tcId, {
      status: verdicts[last[1] ?? ''] ?? 'Blocked',
      durationMs: null,
      ...(error ? { error } : {}),
    });
  }
  return out;
}

/** @param {string} text */
function parseJsonReport(text) {
  /** @type {Map<string, Verdict>} */
  const out = new Map();
  const data = JSON.parse(text);
  const mapStatus = (/** @type {string | undefined} */ s) => {
    if (s === 'passed') return 'Pass';
    if (s === 'failed' || s === 'timedOut') return 'Fail';
    if (s === 'skipped') return 'Skipped';
    if (s === 'interrupted') return 'Blocked';
    return null;
  };
  const walk = (/** @type {PwSuite} */ suite) => {
    for (const spec of suite.specs ?? []) {
      const tcId = extractTcId(spec.title ?? '');
      if (!tcId) continue;
      let verdict = 'Pass';
      let dur = 0;
      let error;
      for (const t of spec.tests ?? []) {
        for (const r of t.results ?? []) {
          dur += r.duration ?? 0;
          const v = mapStatus(r.status);
          if (v === 'Fail' || v === 'Blocked') {
            verdict = v;
            error = String(r.error?.message ?? '').split('\n')[0] || error;
          } else if (v === 'Skipped' && verdict === 'Pass') verdict = 'Skipped';
        }
      }
      out.set(tcId, { status: verdict, durationMs: dur || null, ...(error ? { error } : {}) });
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const s of data.suites ?? []) walk(s);
  return out;
}

const REPORT_PARSERS = [
  { match: /(^|\/)output\.xml$/i, parse: parseRobot },
  { match: /(^|\/)results\.json$/i, parse: parseJsonReport },
];

/**
 * @param {string} dir
 * @param {(file: string) => boolean} predicate
 * @param {string[]} [acc]
 * @returns {string[]}
 */
function walkFiles(dir, predicate, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, predicate, acc);
    else if (predicate(full)) acc.push(full);
  }
  return acc;
}

/** @param {string} file */
function parserFor(file) {
  return REPORT_PARSERS.find((p) => p.match.test(file.replace(/\\/g, '/')));
}

function findLatestReport() {
  let newest = null;
  for (const f of walkFiles(OUTPUTS_DIR, (p) => parserFor(p) !== undefined)) {
    const mtime = fs.statSync(f).mtimeMs;
    if (!newest || mtime > newest.mtime) newest = { file: f, mtime };
  }
  return newest?.file;
}

/**
 * @param {string} file
 * @returns {ProjectMeta | null}
 */
function projectFromReport(file) {
  const rel = path.relative(OUTPUTS_DIR, path.resolve(file)).replace(/\\/g, '/');
  const [tool, type, project] = rel.split('/');
  if (!tool || !type || !project || rel.startsWith('..')) return null;
  return { tool, type, project };
}

/**
 * @param {string} docPath
 * @returns {{ sheets: Sheet[], editors?: Record<string, string> } | null}
 */
function readSheets(docPath) {
  try {
    const overlay = JSON.parse(fs.readFileSync(`${docPath}${OVERLAY_SUFFIX}`, 'utf8'));
    if (Array.isArray(overlay.sheets)) return { sheets: overlay.sheets, editors: overlay.editors };
  } catch {}
  const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'xlsx-sheets.py');
  const res = spawnSync('uv', ['run', '--with', 'openpyxl', 'python', helper, docPath], {
    encoding: 'utf-8',
  });
  if (res.error || res.status !== 0) {
    process.stderr.write(`  • cannot read ${docPath} (${res.error?.message ?? res.stderr})\n`);
    return null;
  }
  return { sheets: JSON.parse(res.stdout) };
}

/**
 * @param {ProjectMeta} meta
 * @param {Map<string, Verdict>} verdicts
 * @param {string} source
 */
function writeStatusJson(meta, verdicts, source) {
  const dir = path.join(OUTPUTS_DIR, 'test-status', meta.tool, meta.type, meta.project);
  const file = path.join(dir, 'status.json');
  /** @type {StatusFile} */
  let prev = { cases: {}, history: [] };
  try {
    prev = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {}
  const now = new Date().toISOString();
  /** @type {Record<string, number>} */
  const summary = { pass: 0, fail: 0, skipped: 0, blocked: 0, total: verdicts.size };
  const prevCases = prev.cases ?? {};
  /** @type {string[]} */
  const regressions = [];
  /** @type {string[]} */
  const fixed = [];
  /** @type {Record<string, CaseEntry>} */
  const cases = { ...prevCases };
  for (const [id, v] of verdicts) {
    const before = prevCases[id]?.status;
    if (before === 'Pass' && (v.status === 'Fail' || v.status === 'Blocked')) regressions.push(id);
    if ((before === 'Fail' || before === 'Blocked') && v.status === 'Pass') fixed.push(id);
    cases[id] = { status: v.status, durationMs: v.durationMs, lastRun: now };
    const k = v.status.toLowerCase();
    if (k in summary) summary[k] = (summary[k] ?? 0) + 1;
  }
  const history = [{ at: now, source, summary, regressions, fixed }, ...(prev.history ?? [])].slice(
    0,
    HISTORY_LIMIT,
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ ...meta, updatedAt: now, cases, history }, null, 2)}\n`,
  );
  return { summary, regressions, fixed };
}

/** @param {string} file */
export function syncReport(file) {
  const parser = parserFor(file);
  const meta = projectFromReport(file);
  if (!parser || !meta) {
    process.stderr.write(`  • cannot map ${file} to a project, skipped\n`);
    return 0;
  }
  const verdicts = parser.parse(fs.readFileSync(file, 'utf-8'));
  if (verdicts.size === 0) {
    process.stderr.write(`  • no TC-ids found in ${file}\n`);
    return 0;
  }
  const { summary, regressions, fixed } = writeStatusJson(meta, verdicts, file);
  /** @type {Record<string, RunResult>} */
  const resultByCaseId = {};
  for (const [id, v] of verdicts) {
    if (v.status === 'Skipped') continue;
    resultByCaseId[id] = {
      status: v.status === 'Pass' ? 'passed' : 'failed',
      ...(v.error ? { error: v.error } : {}),
    };
  }
  const docsDir = path.join(TOOLS_DIR, meta.tool, 'projects', meta.type, meta.project, 'docs');
  const docs = walkFiles(docsDir, (p) => {
    const name = path.basename(p);
    return DOC_RE.test(name) && !name.startsWith('~$') && !name.endsWith(RESULT_SUFFIX);
  });
  let matched = 0;
  for (const doc of docs) {
    const base = readSheets(doc);
    if (!base) continue;
    matched += syncRunToDoc(doc, base.sheets, resultByCaseId, { editors: base.editors }).matched;
  }
  process.stderr.write(
    `  • ${meta.tool}/${meta.type}/${meta.project}: ${verdicts.size} cases ` +
      `(P${summary.pass}/F${summary.fail}/S${summary.skipped}/B${summary.blocked}), ` +
      `${matched} rows updated in ${docs.length} doc(s)\n`,
  );
  if (regressions.length) process.stderr.write(`  • REGRESSION: ${regressions.join(', ')}\n`);
  if (fixed.length) process.stderr.write(`  • FIXED: ${fixed.join(', ')}\n`);
  return matched;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const inputs = process.argv.slice(2).filter(Boolean);
  const files = inputs.length > 0 ? inputs : [findLatestReport()].filter((f) => f !== undefined);
  if (files.length === 0) process.stderr.write('  • no report found under outputs/\n');
  for (const file of files) syncReport(path.resolve(file));
}
