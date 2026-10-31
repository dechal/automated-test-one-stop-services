import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CiChoice,
  type CiKind,
  checkCiOption,
  GITHUB_WORKFLOW_FILE,
  GITLAB_CI_FILE,
  generateCiFiles,
  isCiSupported,
  LEGACY_GITHUB_WORKFLOW_FILE,
  parseCiChoice,
  readEnvTemplateKeys,
} from '../ci.js';
import { exportProjectStandalone } from '../standalone.js';

let root: string;
let target: string;

function write(rel: string, text: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}
function read(rel: string): string {
  return fs.readFileSync(path.join(target, rel), 'utf8');
}

const ENV_TEMPLATE = 'BASE_URL=""   # default none\n# COMMENTED=1\nexport API_TOKEN=\nWORKERS=""\n';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-ci-'));
  target = path.join(root, 'out');
  write('package.json', '{"volta":{"node":"26.9.0"}}');
  write(
    'tools/playwright/package.json',
    '{"packageManager":"pnpm@11.23.0","devDependencies":{"@playwright/test":"^1.63.0"}}',
  );
  write('tools/k6/package.json', '{"dependencies":{"dayjs":"^1.11.23"}}');
  write(
    'tools/robot-framework/Dockerfile',
    'ARG PLAYWRIGHT_VERSION=1.60.0\nCOPY --from=ghcr.io/astral-sh/uv:0.11.8 /uv /uvx /bin/\n',
  );
  write('out/.env.template', ENV_TEMPLATE);
  write('out/.env', 'BASE_URL="https://secret.example.com"\n');
  write('out/README.md', '# demo\n');
  write('out/automations/specs/rest/e2e.spec.ts', "import dayjs from 'dayjs';\nexport {};\n");
  write(`out/${LEGACY_GITHUB_WORKFLOW_FILE}`, 'name: ci\n');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function ctx(tool: string, kind: CiKind = 'standalone') {
  return { workspaceRoot: root, tool, type: 't', project: 'demo', targetDir: target, kind };
}

describe('parseCiChoice', () => {
  it('defaults to none and rejects unknown values', () => {
    expect(parseCiChoice(undefined)).toBe('none');
    expect(parseCiChoice('')).toBe('none');
    expect(parseCiChoice('both')).toBe('both');
    expect(parseCiChoice('jenkins')).toBeNull();
    expect(parseCiChoice(true)).toBeNull();
  });
});

describe('readEnvTemplateKeys', () => {
  it('reads key names only, skips comments and duplicates', () => {
    expect(readEnvTemplateKeys(`${ENV_TEMPLATE}BASE_URL=x\n\n  =bad\n`)).toEqual([
      'BASE_URL',
      'API_TOKEN',
      'WORKERS',
    ]);
  });
});

describe('isCiSupported / checkCiOption', () => {
  it('supports linux tools for both kinds and pywinauto for bundle only', () => {
    expect(isCiSupported('playwright', 'standalone')).toBe(true);
    expect(isCiSupported('k6', 'bundle')).toBe(true);
    expect(isCiSupported('robot-framework', 'bundle')).toBe(true);
    expect(isCiSupported('pywinauto', 'bundle')).toBe(true);
    expect(isCiSupported('pywinauto', 'standalone')).toBe(false);
    expect(isCiSupported('mobilewright', 'standalone')).toBe(false);
    expect(isCiSupported('constructor', 'bundle')).toBe(false);
  });
  it('returns INVALID_CI and CI_NOT_SUPPORTED codes', () => {
    expect(checkCiOption('x', 'k6', 'bundle')).toMatchObject({ code: 'INVALID_CI' });
    expect(checkCiOption('gitlab', 'pywinauto', 'standalone')).toMatchObject({
      code: 'CI_NOT_SUPPORTED',
    });
    expect(checkCiOption(undefined, 'pywinauto', 'standalone')).toEqual({ choice: 'none' });
  });
});

const LINUX: readonly { tool: string; from: string }[] = [
  { tool: 'playwright', from: 'FROM mcr.microsoft.com/playwright:v1.63.0-noble' },
  { tool: 'k6', from: 'FROM grafana/k6:2.0.0' },
  { tool: 'robot-framework', from: 'FROM mcr.microsoft.com/playwright/python:v1.60.0-noble' },
];
const PROVIDERS: readonly CiChoice[] = ['gitlab', 'github', 'both'];

describe.each(LINUX)('generateCiFiles $tool', ({ tool, from }) => {
  it.each(PROVIDERS)('%s writes the container and the pipeline', (choice) => {
    const res = generateCiFiles(ctx(tool), choice);
    if ('code' in res) throw new Error(res.message);
    const gitlab = choice !== 'github';
    const github = choice !== 'gitlab';
    expect(res.files).toEqual([
      'Dockerfile',
      '.dockerignore',
      ...(gitlab ? [GITLAB_CI_FILE] : []),
      ...(github ? [GITHUB_WORKFLOW_FILE] : []),
    ]);
    expect(read('Dockerfile').split('\n')).toContain(from);
    expect(read('.dockerignore').split('\n')).toContain('.env');
    expect(fs.existsSync(path.join(target, LEGACY_GITHUB_WORKFLOW_FILE))).toBe(!github);
    for (const file of res.files.filter((f) => f.endsWith('.yml'))) {
      const yml = read(file);
      for (const key of ['CI', 'BASE_URL', 'API_TOKEN', 'WORKERS'])
        expect(yml).toContain(`-e ${key}`);
      expect(yml).not.toContain('secret.example.com');
      expect(yml).toContain('docker build -t ci-test .');
      expect(yml).toContain('docker cp ci-test-run:/app/outputs outputs');
      expect(yml).toMatch(/outputs\//);
    }
    if (gitlab) {
      const yml = read(GITLAB_CI_FILE);
      expect(yml).toContain('docker:27-dind');
      expect(yml).toContain('when: always');
    }
    if (github) {
      const yml = read(GITHUB_WORKFLOW_FILE);
      expect(yml).toContain('runs-on: ubuntu-latest');
      expect(yml).toContain('BASE_URL: ${{ secrets.BASE_URL || vars.BASE_URL }}');
      expect(yml).toContain('actions/upload-artifact@v4');
      expect(yml).toContain('if: always()');
    }
    expect(res.readme.join('\n')).toContain('`API_TOKEN`');
  });
});

describe('generateCiFiles k6 specifics', () => {
  it('runs the e2e entry, ships dayjs and rewrites its imports', () => {
    const res = generateCiFiles(ctx('k6', 'bundle'), 'gitlab');
    if ('code' in res) throw new Error(res.message);
    const docker = read('Dockerfile');
    expect(docker).toContain('FROM node:26.9.0-slim AS deps');
    expect(docker).toContain('npm install --no-save --no-package-lock "dayjs@^1.11.23"');
    expect(docker).toContain(
      'CMD ["run", "-e", "SUMMARY_DIR=outputs/k6/demo", "automations/specs/rest/e2e.spec.ts"]',
    );
    expect(read('automations/specs/rest/e2e.spec.ts')).toContain(
      "from '../../../node_modules/dayjs/dayjs.min.js'",
    );
  });
  it('returns ENTRY_NOT_FOUND without an e2e spec', () => {
    fs.rmSync(path.join(target, 'automations'), { recursive: true });
    expect(generateCiFiles(ctx('k6'), 'github')).toMatchObject({ code: 'ENTRY_NOT_FOUND' });
  });
});

describe('generateCiFiles pywinauto bundle', () => {
  it.each(PROVIDERS)('%s targets a Windows runner with run.bat and no Dockerfile', (choice) => {
    const res = generateCiFiles(ctx('pywinauto', 'bundle'), choice);
    if ('code' in res) throw new Error(res.message);
    expect(fs.existsSync(path.join(target, 'Dockerfile'))).toBe(false);
    if (choice !== 'github') {
      const yml = read(GITLAB_CI_FILE);
      expect(yml).toContain('  tags:\n    - windows');
      expect(yml).toContain('cmd /c run.bat -rA');
      expect(yml).not.toContain('docker');
    }
    if (choice !== 'gitlab') {
      const yml = read(GITHUB_WORKFLOW_FILE);
      expect(yml).toContain('runs-on: [self-hosted, windows]');
      expect(yml).toContain('shell: cmd');
      expect(yml).toContain('run: run.bat -rA');
    }
    expect(res.readme.join('\n')).toContain('Windows runner');
  });
});

describe('generateCiFiles none', () => {
  it('writes nothing and keeps the legacy workflow', () => {
    expect(generateCiFiles(ctx('playwright'), 'none')).toEqual({ files: [], readme: [] });
    expect(fs.existsSync(path.join(target, 'Dockerfile'))).toBe(false);
    expect(fs.existsSync(path.join(target, LEGACY_GITHUB_WORKFLOW_FILE))).toBe(true);
  });
});

describe('exportProjectStandalone ci validation', () => {
  const opts = (tool: string, ci: CiChoice | 'bogus') => ({
    workspaceRoot: root,
    tool,
    type: 'desktop',
    project: 'demo',
    targetDir: path.join(root, 'fresh'),
    ci: ci as CiChoice,
  });
  it('rejects CI for standalone pywinauto before writing', async () => {
    expect(await exportProjectStandalone(opts('pywinauto', 'github'))).toMatchObject({
      code: 'CI_NOT_SUPPORTED',
    });
    expect(fs.existsSync(path.join(root, 'fresh'))).toBe(false);
  });
  it('rejects an unknown provider', async () => {
    expect(await exportProjectStandalone(opts('k6', 'bogus'))).toMatchObject({
      code: 'INVALID_CI',
    });
  });
  it('keeps TOOL_NOT_SUPPORTED for mobilewright', async () => {
    expect(await exportProjectStandalone(opts('mobilewright', 'both'))).toMatchObject({
      code: 'TOOL_NOT_SUPPORTED',
    });
  });
});
