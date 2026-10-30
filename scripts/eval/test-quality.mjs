#!/usr/bin/env node
// @ts-nocheck
/**
 * test-quality.mjs — repeatable quality SCORE for generated test code.
 *
 * This is a scoring / reporting harness, NOT a hard write-time gate. It
 * deliberately does NOT duplicate the existing gates:
 *   - biome / ruff / robocop  → syntax + style
 *   - the AI layer's write-time gate → secrets, raw-locator-in-spec, no `any`
 *
 * Instead it measures quality dimensions those gates miss, so a team can track
 * the trend over time and catch drift (e.g. in CI as a soft signal):
 *   - hardcoded waits (anti-pattern; prefer web-first auto-waiting assertions)
 *   - presence of assertions at all (a test with no assertion proves nothing)
 *   - brittle locators (xpath / nth / deep css) vs role/label/testid
 *   - requirement / test-case traceability tag (@REQ-… / @TC-… / id: 'TC-…')
 *   - hardcoded URLs (should come from env per portability-and-config)
 *
 * Everything tunable is an env var with a safe default (portability rule):
 *   EVAL_ROOTS      comma-separated dirs to scan      (default: "tools")
 *   EVAL_MIN_SCORE  fail if AVERAGE score is below it (default: 70)
 *   EVAL_JSON       "1" → emit JSON instead of text   (default: text report)
 *
 * CLI (CLI-first, cross-OS, no deps):
 *   node scripts/eval/test-quality.mjs [root ...]
 *   node scripts/eval/test-quality.mjs --json
 *   node scripts/eval/test-quality.mjs --selftest
 *
 * Exit code: 0 when average >= EVAL_MIN_SCORE (or no files found), else 1.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toolArtefactDirs } from '../lib/tool-artefact-dirs.mjs';

const MIN_SCORE = Number(process.env.EVAL_MIN_SCORE ?? 70);
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.venv',
  'outputs',
  'coverage',
  '.cache',
  ...toolArtefactDirs(),
]);

// ─── rubric ──────────────────────────────────────────────────────────────────
// Each rule: { id, weight, kind, applies(file), detect(text) -> hits }
// "penalty" rules subtract weight per hit (capped at cap). "required" rules
// subtract weight once if the pattern is absent.
const RULES = [
  {
    id: 'hardcoded-wait',
    kind: 'penalty',
    weight: 15,
    cap: 45,
    applies: () => true,
    detect: (t) =>
      count(t, /\bwaitForTimeout\s*\(/g) +
      count(t, /\bpage\.wait_for_timeout\s*\(/g) +
      count(t, /\btime\.sleep\s*\(/g) +
      count(t, /^\s*Sleep\s+\d/gim),
  },
  {
    id: 'brittle-locator',
    kind: 'penalty',
    weight: 10,
    cap: 30,
    applies: (f) => f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.robot'),
    detect: (t) =>
      count(t, /\bxpath\s*=/gi) +
      count(t, /['"`]\/\/[a-z]/gi) + // string literal starting with //elem (absolute xpath)
      count(t, /\.nth\(\s*\d+\s*\)/g) +
      count(t, /:nth-child\(/g),
  },
  {
    id: 'hardcoded-url',
    kind: 'penalty',
    weight: 10,
    cap: 20,
    applies: () => true,
    detect: (t) => count(t, /["'`]https?:\/\/(?!localhost|127\.0\.0\.1)[^"'`]+["'`]/g),
  },
  {
    id: 'missing-assertion',
    kind: 'required',
    weight: 20,
    applies: () => true,
    present: (t) =>
      /\bexpect\s*\(/.test(t) || // playwright / jest
      /\btoBe|toEqual|toContain|toHaveText|toBeVisible/.test(t) ||
      /\bcheck\s*\(/.test(t) || // k6
      /(Should\s+(Be|Contain)|Wait\s+Until|Page\s+Should)/i.test(t), // robot
  },
  {
    id: 'missing-traceability',
    kind: 'required',
    weight: 10,
    applies: () => true,
    present: (t) =>
      /@?(REQ|TC)-[A-Z0-9]+/.test(t) ||
      /\bid\s*:\s*['"`](REQ|TC)-/.test(t) ||
      /\[Tags\][^\n]*\b(REQ|TC)-/i.test(t),
  },
];

function count(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

/** Score one file's text. Returns { score, findings[] }. */
export function scoreText(text, file = 'inline.ts') {
  let score = 100;
  const findings = [];
  for (const rule of RULES) {
    if (!rule.applies(file)) continue;
    if (rule.kind === 'penalty') {
      const hits = rule.detect(text);
      if (hits > 0) {
        const deduct = Math.min(hits * rule.weight, rule.cap);
        score -= deduct;
        findings.push(`-${deduct} ${rule.id} (${hits}x)`);
      }
    } else {
      if (!rule.present(text)) {
        score -= rule.weight;
        findings.push(`-${rule.weight} ${rule.id}`);
      }
    }
  }
  return { score: Math.max(0, score), findings };
}

const TEST_FILE = /(\.(spec|test)\.(ts|js)|\.robot|\.k6\.(ts|js))$/;

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (TEST_FILE.test(e.name)) out.push(full);
  }
  return out;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const asJson = argv.includes('--json') || process.env.EVAL_JSON === '1';
  const roots = argv.filter((a) => !a.startsWith('--'));
  const scanRoots = roots.length
    ? roots
    : (process.env.EVAL_ROOTS ?? 'tools').split(',').map((s) => s.trim());

  const files = [];
  for (const r of scanRoots) {
    try {
      if (statSync(r).isDirectory()) walk(r, files);
      else files.push(r);
    } catch {
      // root missing — skip, reported via empty result
    }
  }

  const results = files.map((f) => {
    const { score, findings } = scoreText(safeRead(f), f);
    return { file: relative(process.cwd(), f).split(sep).join('/'), score, findings };
  });

  if (results.length === 0) {
    const msg = `no test files found under: ${scanRoots.join(', ')}`;
    if (asJson) console.log(JSON.stringify({ files: 0, average: null, note: msg }, null, 2));
    else console.log(`test-quality: ${msg}`);
    return 0; // nothing to fail on
  }

  const avg = Math.round(results.reduce((s, r) => s + r.score, 0) / results.length);
  const below = results.filter((r) => r.score < MIN_SCORE).sort((a, b) => a.score - b.score);
  const pass = avg >= MIN_SCORE;

  if (asJson) {
    console.log(
      JSON.stringify(
        { files: results.length, average: avg, min: MIN_SCORE, pass, results },
        null,
        2,
      ),
    );
  } else {
    console.log(`test-quality — ${results.length} file(s), average ${avg}/100 (min ${MIN_SCORE})`);
    for (const r of below)
      console.log(`  ${r.score}/100  ${r.file}\n      ${r.findings.join('; ')}`);
    console.log(pass ? '✓ average meets threshold' : `✗ average ${avg} below ${MIN_SCORE}`);
  }
  return pass ? 0 : 1;
}

function safeRead(f) {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return '';
  }
}

function selftest() {
  const cases = [
    [
      'clean',
      "import { expect } from '@playwright/test';\n// @TC-X-001\nexpect(page.getByRole('button')).toBeVisible();",
      100,
    ],
    ['waits', 'await page.waitForTimeout(2000);\nexpect(x).toBe(1);\n// @REQ-1', 85],
    ['no-assert-no-trace', 'const x = 1;', 70], // -20 missing-assertion -10 missing-traceability
  ];
  let ok = true;
  for (const [name, text, want] of cases) {
    const { score } = scoreText(text, 'x.spec.ts');
    const got = score === want;
    ok = ok && got;
    console.log(`${got ? 'ok  ' : 'FAIL'} ${name}: got ${score}, want ${want}`);
  }
  return ok ? 0 : 1;
}

// Run only when invoked as a CLI, not when imported (keeps `scoreText`
// importable for tests without triggering a filesystem scan).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
