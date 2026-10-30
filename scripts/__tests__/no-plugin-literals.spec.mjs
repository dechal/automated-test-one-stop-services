// @ts-check
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE_SUFFIX = '-template-example';

/** @typedef {{ file: RegExp, line?: RegExp, reason: string }} Allow */
/** @typedef {{ file: string, line: number, text: string, kind: 'path' | 'id' }} Hit */

/** @type {readonly RegExp[]} */
const OUT_OF_SCOPE = [
  /^hub\//,
  /(^|\/)__tests__\//,
  /\.(spec|test)\.[cm]?[jt]sx?$/,
  /\.md$/,
  /^pnpm-lock\.yaml$/,
  /^uv\.lock$/,
];

/** @type {readonly Allow[]} */
const ALLOW_ID = [
  { file: /^\.gitignore$/, reason: 'ignore file' },
  { file: /^\.dockerignore$/, reason: 'ignore file' },
  { file: /^\.kiroignore$/, reason: 'ignore file' },
  { file: /^\.markdownlint-cli2\.jsonc$/, reason: 'ignore list of the markdown gate' },
  { file: /^biome\.json$/, reason: 'ignore list of the lint gate' },
  { file: /^\.vscode\/settings\.json$/, reason: 'editor exclude lists' },
  { file: /^\.vscode\/extensions\.json$/, reason: 'editor extension recommendations' },
  { file: /^config\/tool-registry\.json$/, reason: 'install catalogue: tool names are its data' },
  { file: /^pyproject\.toml$/, line: /\.kiro/, reason: 'ruff / ty exclude entries' },
  {
    file: /^pnpm-workspace\.yaml$/,
    line: /^\s+['"]?[@\w./-]+['"]?:\s*['"]?[\d^~]/,
    reason: 'dependency catalog: an npm package name may equal a tool id',
  },
  {
    file: /^scripts\/sync-projects\.ts$/,
    line: /^\s*'\.kiro',$/,
    reason: 'template walk skip list',
  },
  {
    file: /^scripts\/manifests\/(types|validate)\.ts$/,
    line: /'playwright-list'/,
    reason: 'tag strategy name; a rename needs approval (plan SF-06)',
  },
  {
    file: /^scripts\/eval\/test-quality\.mjs$/,
    line: /TEST_FILE = |from '@playwright\/test'/,
    reason: 'rubric: test-file name pattern and its selftest fixture',
  },
  {
    file: /^scripts\/export\//,
    reason: 'per-tool export strategies; moving them into tools/<id>/ via manifest is a follow-up',
  },
  {
    file: /^(scripts\/setup\/setup-linux\.sh|scripts\/setup\/setup-windows\.bat)$/,
    line: /PLAYWRIGHT_BROWSERS_PATH/,
    reason: 'installer persists the shared browser cache env for shells outside task',
  },
  {
    file: /^scripts\/clean-cache\.mjs$/,
    line: /'playwright-browsers',/,
    reason: 'keep-list entry that protects the shared browser cache from deletion',
  },
  {
    file: /^scripts\/setup\/setup-windows\.bat$/,
    line: /^\s*echo \[aux\] Installing tesseract/,
    reason: 'user-facing log text naming why an optional dependency is installed',
  },
  {
    file: /^scripts\/setup\/uninstall\.mjs$/,
    line: /playwright-browsers|mk\('tools'|'tools', 'playwright'/,
    reason: 'uninstall hint text and its built-in selftest fixture tree',
  },
];

/** @type {readonly Allow[]} */
const ALLOW_PATH = [
  {
    file: /^scripts\/export\//,
    reason: 'per-tool export strategies; moving them into tools/<id>/ via manifest is a follow-up',
  },
  {
    file: /^(\.vscode\/settings\.json|lefthook\.yml)$/,
    line: /tools\/robot-framework\/robot\.toml/,
    reason: 'robocop config path; editor and hook need a literal path, no manifest lookup exists',
  },
  {
    file: /^scripts\/setup\/uninstall\.mjs$/,
    line: /\['tools\/playwright\/projects\/web\/my-project'\]/,
    reason: 'expected value in the built-in uninstall selftest fixture',
  },
];

const COMMENT_LINE = /^\s*(#|\/\/|\/\*|\*|REM\b|::|<!--)/i;
const TRAILING_COMMENT = /\s+(\/\/|#\s).*$/;

/** @param {string} id */
function escapeRegExp(id) {
  return id.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/**
 * @param {string} file
 * @returns {string[]}
 */
function registryNames(file) {
  try {
    const tools = JSON.parse(fs.readFileSync(file, 'utf8')).tools;
    return Array.isArray(tools)
      ? tools.map((t) => t?.name).filter((n) => typeof n === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * @param {string} root
 * @returns {string[]}
 */
export function knownToolIds(root) {
  const ids = new Set(registryNames(path.join(root, 'config', 'tool-registry.json')));
  const toolsDir = path.join(root, 'tools');
  if (fs.existsSync(toolsDir)) {
    for (const entry of fs.readdirSync(toolsDir, { withFileTypes: true })) {
      const manifest = path.join(toolsDir, entry.name, 'tool.manifest.json');
      if (entry.isDirectory() && !entry.name.endsWith(TEMPLATE_SUFFIX) && fs.existsSync(manifest)) {
        ids.add(entry.name);
      }
    }
  }
  return [...ids].sort();
}

/**
 * @param {readonly Allow[]} allow
 * @param {string} file
 * @param {string} line
 */
function allowed(allow, file, line) {
  return allow.some((a) => a.file.test(file) && (a.line === undefined || a.line.test(line)));
}

/**
 * @param {string} root
 * @param {readonly string[]} files
 * @param {readonly string[]} ids
 * @returns {Hit[]}
 */
export function scan(root, files, ids) {
  const alt = ids.map(escapeRegExp).join('|');
  const pathRe = new RegExp(`tools[\\\\/](${alt})(?![A-Za-z0-9_-])`);
  const idRe = new RegExp(`(?<![A-Za-z0-9_])(${alt})(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])\\.kiro\\b`);
  /** @type {Hit[]} */
  const hits = [];
  for (const file of files) {
    if (OUT_OF_SCOPE.some((re) => re.test(file))) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    text.split(/\r?\n/).forEach((raw, index) => {
      if (COMMENT_LINE.test(raw)) return;
      const line = raw.replace(TRAILING_COMMENT, '');
      const hit = { file, line: index + 1, text: raw.trim().slice(0, 160) };
      if (pathRe.test(line) && !allowed(ALLOW_PATH, file, line))
        hits.push({ ...hit, kind: 'path' });
      else if (idRe.test(line) && !pathRe.test(line) && !allowed(ALLOW_ID, file, line)) {
        hits.push({ ...hit, kind: 'id' });
      }
    });
  }
  return hits;
}

/** @param {string} root */
function trackedFiles(root) {
  return execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((f) => f !== '');
}

test('scanner flags a tool path, a bare tool id and .kiro, and honours the allow-list', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'no-plugin-literals-'));
  /** @type {Record<string, string>} */
  const files = {
    'Taskfile.yml':
      'cmds:\n  - run tools/acme/x\n  # tools/acme in a comment\n  - echo acme-report\n',
    'scripts/a.ts':
      "const skip = ['.kiro'];\nconst url = 'https://x.test'; // acme here is a comment\n",
    'pyproject.toml': 'members = ["tools/acme"]\nextra = ["tools/acme/resources"]\n',
    '.gitignore': 'acme-report/\n.kiro/\n',
    'scripts/__tests__/x.spec.mjs': "const id = 'tools/acme';\n",
    'docs.md': 'Uses tools/acme.\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  const hits = scan(root, Object.keys(files), ['acme']).map((h) => `${h.kind} ${h.file}:${h.line}`);
  assert.deepEqual(hits, [
    'path Taskfile.yml:2',
    'id Taskfile.yml:4',
    'id scripts/a.ts:1',
    'path pyproject.toml:1',
    'path pyproject.toml:2',
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('root files name no tool and no AI layer outside the allow-list (guard G-02)', () => {
  const ids = knownToolIds(ROOT);
  assert.ok(ids.length > 0, 'no tool ids found: config/tool-registry.json is missing or empty');
  const hits = scan(ROOT, trackedFiles(ROOT), ids);
  const report = hits.map((h) => `  ${h.kind} ${h.file}:${h.line}  ${h.text}`).join('\n');
  assert.equal(
    hits.length,
    0,
    `root files name a plugin; move it into the tool or its manifest:\n${report}`,
  );
});
