#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = 'tools';
const MANIFEST = 'tool.manifest.json';
const OUTPUT = 'pyrightconfig.json';
const VENV = '.venv';
const RESOURCES = 'resources';

const BASE = {
  venvPath: '.',
  venv: VENV,
  pythonVersion: '3.14',
  typeCheckingMode: 'standard',
  useLibraryCodeForTypes: true,
  reportMissingImports: 'warning',
  reportMissingModuleSource: 'warning',
  reportAttributeAccessIssue: 'error',
  reportUnnecessaryTypeIgnoreComment: 'warning',
  reportUnnecessaryComparison: 'warning',
  reportGeneralTypeIssues: 'none',
  reportCallIssue: 'error',
  reportArgumentType: 'error',
  exclude: [
    '**/node_modules',
    '**/__pycache__',
    '**/.venv',
    '**/generated',
    '**/outputs',
    '**/results',
    '**/reports',
    '**/logs',
    '**/dist',
    '**/.git',
    '**/.kiro',
    '**/.cache',
  ],
};

const toPosix = (p) => p.split(path.sep).join('/');

export function sitePackages(venvDir, platform = process.platform) {
  if (platform === 'win32') {
    const win = path.join(venvDir, 'Lib', 'site-packages');
    return existsSync(win) ? win : null;
  }
  const lib = path.join(venvDir, 'lib');
  if (!existsSync(lib)) return null;
  const py = readdirSync(lib).find((name) => name.startsWith('python'));
  const site = py ? path.join(lib, py, 'site-packages') : null;
  return site && existsSync(site) ? site : null;
}

export function pythonTools(root = ROOT) {
  const toolsDir = path.join(root, TOOLS_DIR);
  if (!existsSync(toolsDir)) return [];
  return readdirSync(toolsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(toolsDir, entry.name))
    .filter((dir) => {
      const file = path.join(dir, MANIFEST);
      if (!existsSync(file)) return false;
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      return manifest.runtime === 'python' && manifest.enabled !== false;
    })
    .sort();
}

export function buildConfig(root = ROOT, platform = process.platform) {
  const environments = pythonTools(root).map((dir) => {
    const extraPaths = [path.join(dir, RESOURCES), sitePackages(path.join(dir, VENV), platform)]
      .filter((p) => p && existsSync(p))
      .map((p) => toPosix(path.relative(root, p)));
    return { root: toPosix(path.relative(root, dir)), extraPaths };
  });
  return { ...BASE, executionEnvironments: [...environments, { root: '.' }] };
}

export function renderConfig(root = ROOT) {
  return `${JSON.stringify(buildConfig(root), null, 2)}\n`;
}

export function writePyrightConfig(root = ROOT) {
  writeFileSync(path.join(root, OUTPUT), renderConfig(root));
  return OUTPUT;
}

function main() {
  const target = path.join(ROOT, OUTPUT);
  const next = renderConfig();
  const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (process.argv.includes('--check')) {
    if (current !== next) {
      console.error(`${OUTPUT} is stale. Run: node scripts/pyright-config.mjs`);
      process.exit(1);
    }
    console.log(`${OUTPUT} is up to date.`);
    return;
  }
  writePyrightConfig();
  console.log(
    `Wrote ${OUTPUT} for ${buildConfig().executionEnvironments.length - 1} Python tool(s).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
