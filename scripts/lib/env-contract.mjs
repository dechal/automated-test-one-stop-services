#!/usr/bin/env node
// ============================================================================
// env-contract.mjs — is every env var the code reads declared in a .env.template?
// ----------------------------------------------------------------------------
// steering `portability-and-config` §1 calls the committed `.env.template` "the
// single contract of what is tunable". Nothing enforced it, so a key could be
// read at runtime and never appear in any template — the failure shows up as an
// empty string deep inside a run, not as an error.
//
// What counts as a read (per runtime, as documented in that steering):
//   Playwright / Node   process.env.KEY            process.env['KEY']
//   k6                  __ENV.KEY                  __ENV['KEY']
//   Robot Framework     %{KEY}                     %{KEY=default}
//
// Where a key may be declared — a key is satisfied by ANY of these, because the
// three levels are one contract from the code's point of view:
//   <project>/.env.template     per-project knobs (base URLs, credentials)
//   tools/<tool>/.env.template  tool provisioning knobs (mirrors, hosts)
//   scripts/.env.template       workspace knobs (usage logging)
// plus RUNNER_PROVIDED below, for values the Taskfile or the platform injects.
//
// Usage:
//   node scripts/lib/env-contract.mjs              # report on this workspace
//   node scripts/lib/env-contract.mjs <root>       # report on another root
//   node scripts/lib/env-contract.mjs --strict     # exit 1 when anything is missing
//   node scripts/lib/env-contract.mjs --json
//
// Known ceiling: a computed name (`process.env[`PREFIX_${x}`]`) cannot be matched
// by any static scan, so it is silently skipped rather than guessed at.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { toolArtefactDirs } from './tool-artefact-dirs.mjs';

/**
 * Values the runner or the platform supplies, so no `.env.template` declares
 * them. Sources: the root Taskfile `env:` block (CURRENT_*, PLAYWRIGHT_BROWSERS_PATH),
 * per-run task variables, and standard runtime flags.
 */
const RUNNER_PROVIDED = new Set([
  'CI',
  'NODE_ENV',
  'TZ',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'CURRENT_USER',
  'PLAYWRIGHT_BROWSERS_PATH',
  'PROJECT',
  'TYPE',
  'TAG',
  'SECTION',
  'PERFORMANCE_TYPE',
]);

/** Directories never worth walking. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.venv',
  '.git',
  'dist',
  'build',
  'outputs',
  '__pycache__',
  '.cache',
  ...toolArtefactDirs(),
]);

const JS_EXT = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.tsx']);
const ROBOT_EXT = new Set(['.robot', '.resource']);

/** `process.env.KEY` / `process.env['KEY']` / `__ENV.KEY` / `__ENV['KEY']`. */
const JS_PATTERNS = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  /__ENV\.([A-Z_][A-Z0-9_]*)/g,
  /__ENV\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
];
/** `%{KEY}` or `%{KEY=default}` — the default does not exempt it from the contract. */
const ROBOT_PATTERN = /%\{\s*([A-Z_][A-Z0-9_]*)\s*(?:=[^}]*)?\}/g;

/** Every file under `dir` worth scanning, as absolute paths. */
function walkFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (JS_EXT.has(ext) || ROBOT_EXT.has(ext)) out.push(full);
    }
  }
  return out;
}

/**
 * Env keys read anywhere under `dir`.
 * @returns {Map<string, string[]>} key → `relative/path:line` references
 */
export function collectEnvRefs(dir) {
  const refs = new Map();
  for (const file of walkFiles(dir)) {
    const ext = path.extname(file);
    const patterns = ROBOT_EXT.has(ext) ? [ROBOT_PATTERN] : JS_PATTERNS;
    let lines;
    try {
      lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    } catch {
      continue;
    }
    lines.forEach((line, i) => {
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let m = pattern.exec(line);
        while (m !== null) {
          const key = m[1];
          const where = `${path.relative(dir, file).replace(/\\/g, '/')}:${i + 1}`;
          const list = refs.get(key);
          if (list) {
            if (!list.includes(where)) list.push(where);
          } else {
            refs.set(key, [where]);
          }
          m = pattern.exec(line);
        }
      }
    });
  }
  return refs;
}

/** Keys declared by a `.env.template` (`KEY=`, comments and blanks ignored). */
export function declaredKeys(templatePath) {
  const keys = new Set();
  let text;
  try {
    text = fs.readFileSync(templatePath, 'utf8');
  } catch {
    return keys;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/** `tools/<tool>/projects/<type>/<project>` directories under `root`. */
function findProjects(root) {
  const found = [];
  const dirsIn = (p) => {
    try {
      return fs
        .readdirSync(p, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  };
  for (const tool of dirsIn(path.join(root, 'tools'))) {
    const projectsDir = path.join(root, 'tools', tool, 'projects');
    for (const type of dirsIn(projectsDir)) {
      for (const project of dirsIn(path.join(projectsDir, type))) {
        found.push({ tool, type, project, dir: path.join(projectsDir, type, project) });
      }
    }
  }
  return found;
}

/**
 * Audit one project against the three declaration levels.
 * @returns {{id: string, dir: string, missing: {key: string, refs: string[]}[]}}
 */
export function auditProject(root, project) {
  const declared = new Set([
    ...declaredKeys(path.join(project.dir, '.env.template')),
    ...declaredKeys(path.join(root, 'tools', project.tool, '.env.template')),
    ...declaredKeys(path.join(root, 'scripts', '.env.template')),
  ]);
  const missing = [];
  for (const [key, refs] of collectEnvRefs(project.dir)) {
    if (declared.has(key) || RUNNER_PROVIDED.has(key)) continue;
    missing.push({ key, refs });
  }
  missing.sort((a, b) => a.key.localeCompare(b.key));
  return {
    id: `${project.tool}/${project.type}/${project.project}`,
    dir: project.dir,
    missing,
  };
}

/** Audit every project under `root`. Projects with nothing missing are included. */
export function auditWorkspace(root) {
  return findProjects(root).map((p) => auditProject(root, p));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const asJson = argv.includes('--json');
  const root = argv.find((a) => !a.startsWith('--')) || process.cwd();
  const results = auditWorkspace(root);
  const withFindings = results.filter((r) => r.missing.length > 0);
  if (asJson) {
    console.log(
      JSON.stringify({ root, projects: results.length, findings: withFindings }, null, 2),
    );
  } else {
    console.log('');
    console.log(`env contract — ${results.length} project(s) scanned under ${root}`);
    if (withFindings.length === 0) {
      console.log('  every env var the code reads is declared in a .env.template.');
    }
    for (const r of withFindings) {
      console.log('');
      console.log(`  ${r.id} — ${r.missing.length} undeclared key(s)`);
      for (const { key, refs } of r.missing) {
        console.log(
          `    ! ${key}  (${refs.slice(0, 3).join(', ')}${refs.length > 3 ? ', …' : ''})`,
        );
      }
    }
    console.log('');
    console.log(
      withFindings.length > 0
        ? `  Fix: add each key to the project's .env.template with a placeholder + one-line comment.`
        : '',
    );
  }
  process.exit(strict && withFindings.length > 0 ? 1 : 0);
}
