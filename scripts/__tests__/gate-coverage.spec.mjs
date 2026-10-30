// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.cache', 'outputs']);

/**
 * @param {string} dir
 * @param {string} name
 * @returns {string[]}
 */
function findFiles(dir, name) {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) out.push(...findFiles(full, name));
    else if (entry.isFile() && entry.name === name) out.push(full);
  }
  return out;
}

/**
 * @param {string} taskfileText
 * @param {string} task
 * @returns {string}
 */
export function taskBlock(taskfileText, task) {
  const lines = taskfileText.split(/\r?\n/);
  const start = lines.indexOf(`  ${task}:`);
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l) || /^\S/.test(l));
  return rest.slice(0, end === -1 ? rest.length : end).join('\n');
}

/**
 * @param {string} text
 * @returns {string}
 */
export function stripJsonComments(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) break;
      i++;
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** @param {string} p */
function tsconfigPath(p) {
  const abs = path.resolve(ROOT, p);
  return fs.existsSync(abs) && fs.statSync(abs).isDirectory()
    ? path.join(abs, 'tsconfig.json')
    : abs;
}

/**
 * @param {string} file
 * @param {Set<string>} seen
 */
function addWithReferences(file, seen) {
  if (seen.has(file) || !fs.existsSync(file)) return;
  seen.add(file);
  const config = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
  for (const ref of config.references ?? []) {
    if (typeof ref?.path === 'string')
      addWithReferences(tsconfigPath(path.join(path.dirname(file), ref.path)), seen);
  }
}

/**
 * @param {string} checkBlock
 * @returns {Set<string>}
 */
export function gatedTsconfigs(checkBlock) {
  /** @type {Set<string>} */
  const seen = new Set();
  for (const m of checkBlock.matchAll(/tsc\b[^\n]*?\s-p\s+["']?([^\s"']+)/g)) {
    if (m[1] !== undefined) addWithReferences(tsconfigPath(m[1]), seen);
  }
  for (const m of checkBlock.matchAll(/tsc\b[^\n]*?\s(?:-b|--build)\s+([^\n|&;]+)/g)) {
    for (const p of (m[1] ?? '').trim().split(/\s+/)) {
      if (p !== '' && !p.startsWith('-')) addWithReferences(tsconfigPath(p), seen);
    }
  }
  if (/pnpm\b[^\n]*\s(-r|--recursive)\b[^\n]*\btypecheck\b/.test(checkBlock)) {
    for (const pkg of findFiles(path.join(ROOT, 'scripts'), 'package.json')) {
      const scripts = JSON.parse(fs.readFileSync(pkg, 'utf8')).scripts ?? {};
      const cfg = path.join(path.dirname(pkg), 'tsconfig.json');
      if (typeof scripts.typecheck === 'string') addWithReferences(cfg, seen);
    }
  }
  return seen;
}

test('every tsconfig under scripts/ is type-checked by root `task check` (guard G-03)', () => {
  const check = taskBlock(fs.readFileSync(path.join(ROOT, 'Taskfile.yml'), 'utf8'), 'check');
  assert.notEqual(check, '', 'root Taskfile.yml has no `check` task');
  const gated = gatedTsconfigs(check);
  const missing = findFiles(path.join(ROOT, 'scripts'), 'tsconfig.json')
    .filter((cfg) => !gated.has(cfg))
    .map((cfg) => path.relative(ROOT, cfg).split(path.sep).join('/'));
  assert.deepEqual(
    missing,
    [],
    `tsconfig projects no gate type-checks:\n  ${missing.join('\n  ')}`,
  );
});

test('every present tool with a package.json or pyproject.toml has a `check` task (guard G-03)', () => {
  const toolsDir = path.join(ROOT, 'tools');
  const tools = fs.existsSync(toolsDir)
    ? fs.readdirSync(toolsDir, { withFileTypes: true }).filter((e) => e.isDirectory())
    : [];
  const missing = [];
  for (const { name } of tools) {
    const dir = path.join(toolsDir, name);
    const manifestFile = path.join(dir, 'tool.manifest.json');
    if (!fs.existsSync(manifestFile)) continue;
    const hasDeps = ['package.json', 'pyproject.toml'].some((f) =>
      fs.existsSync(path.join(dir, f)),
    );
    if (!hasDeps) continue;
    const taskfile = path.join(
      dir,
      JSON.parse(fs.readFileSync(manifestFile, 'utf8')).taskfile ?? 'Taskfile.yml',
    );
    const text = fs.existsSync(taskfile) ? fs.readFileSync(taskfile, 'utf8') : '';
    if (taskBlock(text, 'check') === '' && !/^ {2}check:\s*$/m.test(text)) missing.push(name);
  }
  assert.deepEqual(missing, [], `tools without a \`check\` task: ${missing.join(', ')}`);
});

test('gatedTsconfigs follows -p, -b references and pnpm -r typecheck', () => {
  const block = [
    '      - pnpm exec tsc --noEmit -p scripts/manifests/tsconfig.json',
    '      - pnpm exec tsc -b scripts/install-core',
  ].join('\n');
  const gated = [...gatedTsconfigs(block)].map((p) =>
    path.relative(ROOT, p).split(path.sep).join('/'),
  );
  assert.deepEqual(gated.sort(), [
    'scripts/install-core/tsconfig.json',
    'scripts/manifests/tsconfig.json',
  ]);
});
