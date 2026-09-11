import fs from 'node:fs';
import path from 'node:path';
import type { LifecycleResult } from '@hub/shared';
import { TOOLS_DIR, WORKSPACE_ROOT } from '../config.js';
import { runChild } from './exec.js';

const EMBED_KEY_FILE = '.standalone.json';
const EMBED_SCHEMA = 1;
const INSTALL_TIMEOUT_MS = 300_000;
const RUN_SHELL = process.platform === 'win32';

export const STANDALONE_STAGES = [
  'validate',
  'copy-project',
  'copy-resources',
  'rewrite',
  'generate',
  'embed-key',
  'install',
] as const;

export type StandaloneStage = (typeof STANDALONE_STAGES)[number];

const COPY_SKIP = new Set([
  '.git',
  'node_modules',
  'outputs',
  '.cache',
  'test-results',
  'playwright-report',
  'blob-report',
]);

export interface StandaloneError {
  readonly code:
    | 'TOOL_NOT_SUPPORTED'
    | 'PROJECT_NOT_FOUND'
    | 'SOURCE_MISSING'
    | 'TARGET_NOT_EMPTY'
    | 'TARGET_TOOL_MISMATCH'
    | 'EXPORT_FAILED';
  readonly message: string;
}

export interface StandaloneExport {
  readonly tool: string;
  readonly type: string;
  readonly project: string;
  readonly targetDir: string;
  readonly mode: 'fresh' | 'migrate';
  readonly written: readonly string[];
  readonly installError?: { readonly code: string; readonly message: string };
}

export interface StandaloneOptions {
  readonly tool: string;
  readonly type: string;
  readonly project: string;
  readonly targetDir: string;
  readonly onStage?: (stage: StandaloneStage) => void;
}

interface EmbedKey {
  readonly sourceProject: string;
  readonly tool: string;
  readonly type: string;
  readonly exportedFrom: string;
  readonly exportedAt: string;
  readonly workspaceVersion: string | null;
  readonly schema: number;
}

export interface StandaloneSource {
  readonly projectDir: string;
  readonly resourcesDir: string;
}

export interface StandaloneContext {
  readonly tool: string;
  readonly type: string;
  readonly project: string;
}

export interface StandaloneStrategy {
  readonly copyEntries: readonly string[];
  resolveSource(type: string, project: string): StandaloneSource | StandaloneError;
  rewrite(targetDir: string, ctx: StandaloneContext): void;
  generateFiles(targetDir: string, ctx: StandaloneContext, mode: 'fresh' | 'migrate'): string[];
  installDeps(targetDir: string): Promise<{ code: string; message: string } | undefined>;
}

function copyTree(src: string, dest: string): void {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (from) => !COPY_SKIP.has(path.basename(from)),
  });
}

function isNonEmptyDir(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function readEmbedKey(targetDir: string): EmbedKey | null {
  const keyPath = path.join(targetDir, EMBED_KEY_FILE);
  if (!fs.existsSync(keyPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(keyPath, 'utf8')) as EmbedKey;
  } catch {
    return null;
  }
}

function readWorkspaceVersion(): string | null {
  try {
    const raw = fs.readFileSync(path.join(WORKSPACE_ROOT, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

async function pnpmInstallIgnoreWorkspace(
  targetDir: string,
): Promise<{ code: string; message: string } | undefined> {
  const res = await runChild('pnpm', ['install', '--ignore-workspace'], {
    cwd: targetDir,
    shell: RUN_SHELL,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (res.ok) return undefined;
  return {
    code: 'INSTALL_FAILED',
    message: res.output.trim() || `pnpm install failed (exit ${res.code})`,
  };
}

function resolveToolSource(
  tool: string,
  type: string,
  project: string,
): StandaloneSource | StandaloneError {
  const toolDir = path.join(TOOLS_DIR, tool);
  const projectDir = path.join(toolDir, 'projects', type, project);
  const resourcesDir = path.join(toolDir, 'resources');
  if (!fs.existsSync(projectDir)) {
    return { code: 'SOURCE_MISSING', message: `Source project not found at ${projectDir}` };
  }
  if (!fs.existsSync(resourcesDir)) {
    return { code: 'SOURCE_MISSING', message: `Shared resources not found at ${resourcesDir}` };
  }
  return { projectDir, resourcesDir };
}

function rewritePlaywrightGlobalConfig(targetDir: string): void {
  const file = path.join(targetDir, 'resources', 'src', 'utils', 'playwright-global-config.ts');
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(
    /tsconfig:\s*'(?:\.\.\/)+tsconfig\.json'/,
    "tsconfig: './tsconfig.json'",
  );
  fs.writeFileSync(file, after, 'utf8');
}

function rewriteFileManagementOutputDir(targetDir: string): void {
  const file = path.join(targetDir, 'resources', 'src', 'utils', 'file-management.ts');
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(
    /export function getOutputDirectory\([\s\S]*?\n}/,
    [
      'export function getOutputDirectory(baseDir: string): string {',
      '  void baseDir;',
      "  const outputDir = path.resolve(__dirname, '..', '..', '..', 'outputs', 'playwright');",
      '  return outputDir;',
      '}',
    ].join('\n'),
  );
  fs.writeFileSync(file, after, 'utf8');
}

function buildPlaywrightTsconfig(project: string): string {
  const config = {
    compilerOptions: {
      allowImportingTsExtensions: true,
      allowSyntheticDefaultImports: true,
      esModuleInterop: true,
      isolatedModules: true,
      lib: ['ESNext', 'DOM'],
      module: 'esnext',
      moduleResolution: 'bundler',
      noEmit: true,
      noImplicitOverride: true,
      noImplicitReturns: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
      strict: true,
      target: 'ESNext',
      types: ['@playwright/test', 'node'],
      paths: {
        '~global-resources/*': ['./resources/*'],
        [`~${project}/*`]: ['./*'],
      },
    },
    include: ['automations/**/*.ts', 'src/**/*.ts', 'resources/**/*.ts', 'playwright.config.ts'],
    exclude: ['node_modules/**', 'outputs/**', 'test-results/**', 'playwright-report/**'],
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

function buildPlaywrightPackageJson(project: string): string {
  const pkg = {
    name: project,
    version: '1.0.0',
    private: true,
    packageManager: 'pnpm@11.10.0',
    scripts: {
      test: 'dotenvx run -- playwright test',
      typecheck: 'tsc --noEmit -p tsconfig.json',
    },
    devDependencies: {
      '@dotenvx/dotenvx': '^1.51.0',
      '@faker-js/faker': '^10.5.0',
      '@json2csv/plainjs': '^7.0.7',
      '@playwright/test': '1.63.0',
      dayjs: '^1.11.13',
      'deepmerge-ts': '^7.1.5',
      imapflow: '^1.4.7',
      'tesseract.js': '^7.0.0',
      tsx: '^4.20.0',
      'type-fest': '^5.8.0',
      typescript: '^7.0.2',
    },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function buildPlaywrightGitignore(): string {
  return ['node_modules/', 'outputs/', '.env', 'test-results/', 'playwright-report/', ''].join(
    '\n',
  );
}

function buildPlaywrightDockerfile(): string {
  return [
    'FROM mcr.microsoft.com/playwright:v1.63.0-noble',
    'RUN corepack enable && corepack prepare pnpm@11.10.0 --activate',
    'WORKDIR /app',
    'COPY package.json pnpm-lock.yaml* ./',
    'RUN pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile',
    'COPY . .',
    'CMD ["pnpm", "test"]',
    '',
  ].join('\n');
}

function buildPlaywrightCiWorkflow(): string {
  return [
    'name: e2e',
    'on:',
    '  push:',
    '  workflow_dispatch:',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: pnpm/action-setup@v4',
    '        with:',
    '          version: 11.10.0',
    '      - uses: actions/setup-node@v4',
    '        with:',
    "          node-version: '22'",
    "          cache: 'pnpm'",
    '      - run: pnpm install',
    '      - run: pnpm exec playwright install --with-deps chromium',
    '      - run: pnpm exec tsc --noEmit',
    '      - run: pnpm test',
    '',
  ].join('\n');
}

function buildPlaywrightReadme(project: string): string {
  return [
    `# ${project} (standalone)`,
    '',
    'A self-contained Playwright test project. It was exported from a larger',
    'workspace and carries its own dependencies, config, and shared resources, so',
    'it runs on its own machine with no access to the original workspace.',
    '',
    '## Requirements',
    '',
    '- Node.js 20+ and pnpm (`corepack enable` provides pnpm).',
    '- Internet access on first setup, to download dependencies and the browser.',
    '- `dotenvx` is bundled as a dependency; `pnpm test` runs through it, so no',
    '  global install is needed.',
    '',
    '## Setup',
    '',
    '```sh',
    'pnpm install',
    'pnpm exec playwright install --with-deps chromium',
    '```',
    '',
    'Then create your environment file from the template and fill in the values:',
    '',
    '```sh',
    'cp .env.template .env   # Windows: copy .env.template .env',
    '```',
    '',
    'Every key in `.env.template` is optional (blank = a built-in default); the',
    'inline comments explain each one.',
    '',
    '## Run',
    '',
    '```sh',
    'pnpm test',
    '```',
    '',
    'This runs `dotenvx run -- playwright test` from this folder — it loads `.env`',
    'and executes the Playwright suite in `automations/specs/`.',
    '',
    '### Filter by tag',
    '',
    'Pass a regex through the `PLAYWRIGHT_GREP` env var (it is read into Playwright',
    "`grep`). A CLI `--grep` flag is NOT used, so tags survive Windows' shell.",
    '',
    '```sh',
    'PLAYWRIGHT_GREP=@smoke pnpm test',
    'PLAYWRIGHT_GREP="@smoke|@regression" pnpm test',
    '```',
    '',
    '### Headed / channel',
    '',
    'Set `PW_HEADED=1` to watch the browser, or `PW_CHANNEL=chrome` to use an',
    'installed Chrome instead of the bundled Chromium.',
    '',
    '## Type-check',
    '',
    '```sh',
    'pnpm typecheck',
    '```',
    '',
    '## Results',
    '',
    'Reports and traces are written under `outputs/playwright/`.',
    '',
    '## Continuous integration',
    '',
    'A ready-to-run GitHub Actions workflow lives at `.github/workflows/ci.yml`',
    '(install → browser → type-check → test). A `Dockerfile` is included to run the',
    'suite in the official Playwright image. Both are yours to edit; a re-export',
    'from the workspace will not overwrite them.',
    '',
    '## Layout',
    '',
    '- `automations/` — specs, page modules, and test data.',
    '- `src/` — project-local setup and constants.',
    '- `resources/` — the shared library this project depends on (copied in, so it',
    '  is self-contained). Imports resolve via the `~global-resources/*` path alias',
    '  in `tsconfig.json`.',
    '- `.standalone.json` — marks this folder as an export and records where it came',
    '  from. Pointing the workspace exporter at this same folder again UPDATES the',
    '  code and `resources/` in place while keeping your `.env` and CI untouched.',
    '',
  ].join('\n');
}

const playwrightStrategy: StandaloneStrategy = {
  copyEntries: ['automations', 'src', 'docs', 'states', 'playwright.config.ts'],
  resolveSource(type, project) {
    return resolveToolSource('playwright', type, project);
  },
  rewrite(targetDir) {
    rewritePlaywrightGlobalConfig(targetDir);
    rewriteFileManagementOutputDir(targetDir);
  },
  generateFiles(targetDir, ctx, mode) {
    const written: string[] = [];
    fs.writeFileSync(
      path.join(targetDir, 'tsconfig.json'),
      buildPlaywrightTsconfig(ctx.project),
      'utf8',
    );
    fs.writeFileSync(
      path.join(targetDir, 'package.json'),
      buildPlaywrightPackageJson(ctx.project),
      'utf8',
    );
    fs.writeFileSync(path.join(targetDir, '.gitignore'), buildPlaywrightGitignore(), 'utf8');
    fs.writeFileSync(path.join(targetDir, 'Dockerfile'), buildPlaywrightDockerfile(), 'utf8');
    written.push('tsconfig.json', 'package.json', '.gitignore', 'Dockerfile');
    fs.writeFileSync(path.join(targetDir, 'README.md'), buildPlaywrightReadme(ctx.project), 'utf8');
    written.push('README.md');
    if (mode === 'fresh') {
      const ciDir = path.join(targetDir, '.github', 'workflows');
      fs.mkdirSync(ciDir, { recursive: true });
      fs.writeFileSync(path.join(ciDir, 'ci.yml'), buildPlaywrightCiWorkflow(), 'utf8');
      written.push('.github/workflows/ci.yml');
    }
    return written;
  },
  installDeps(targetDir) {
    return pnpmInstallIgnoreWorkspace(targetDir);
  },
};

const K6_PROJECT_NESTING = 3;

function rewriteK6ResourceImports(targetDir: string): void {
  const drop = '../'.repeat(K6_PROJECT_NESTING);
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const before = fs.readFileSync(full, 'utf8');
      const after = before.replace(
        /((?:\.\.\/)+)resources\//g,
        (_m, climbs: string) =>
          `${climbs.startsWith(drop) ? climbs.slice(drop.length) : climbs}resources/`,
      );
      if (after !== before) fs.writeFileSync(full, after, 'utf8');
    }
  };
  walk(path.join(targetDir, 'src'));
  walk(path.join(targetDir, 'automations'));
}

function rewriteK6FileManagementOutputDir(targetDir: string, project: string): void {
  const file = path.join(targetDir, 'resources', 'src', 'utils', 'file-management.ts');
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(
    /const base = `projects\/performance\/\$\{projectName\}`;/,
    `const base = \`outputs/k6/${project}\`;`,
  );
  fs.writeFileSync(file, after, 'utf8');
}

function buildK6Tsconfig(): string {
  const config = {
    compilerOptions: {
      allowImportingTsExtensions: true,
      allowSyntheticDefaultImports: true,
      esModuleInterop: true,
      isolatedModules: true,
      lib: ['ESNext', 'DOM'],
      module: 'esnext',
      moduleResolution: 'bundler',
      noEmit: true,
      noImplicitOverride: true,
      noImplicitReturns: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
      strict: true,
      target: 'ESNext',
      types: ['@types/k6'],
      paths: {},
    },
    include: ['automations/**/*.ts', 'src/**/*.ts', 'resources/**/*.ts'],
    exclude: ['node_modules/**', 'outputs/**'],
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

function buildK6PackageJson(project: string): string {
  const pkg = {
    name: project,
    version: '1.0.0',
    private: true,
    type: 'module',
    packageManager: 'pnpm@11.10.0',
    scripts: {
      typecheck: 'tsc --noEmit -p tsconfig.json',
    },
    devDependencies: {
      '@dotenvx/dotenvx': '^1.51.0',
      '@types/k6': '^2.0.1',
      puppeteer: '^25.3.0',
      tsx: '^4.20.0',
      typescript: '^7.0.2',
    },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function buildK6Gitignore(project: string): string {
  return [
    'node_modules/',
    'outputs/',
    `!outputs/k6/${project}/`,
    `!outputs/k6/${project}/.gitkeep`,
    'outputs/k6/*/summary.*',
    '.env',
    'summary.html',
    'summary.json',
    '',
  ].join('\n');
}

function buildK6Dockerfile(): string {
  return [
    'FROM grafana/k6:latest',
    'WORKDIR /home/k6',
    'COPY . .',
    'ENTRYPOINT ["k6"]',
    'CMD ["run", "automations/specs/<section>/e2e.spec.ts"]',
    '',
  ].join('\n');
}

function buildK6CiWorkflow(project: string): string {
  return [
    'name: performance',
    'on:',
    '  push:',
    '  workflow_dispatch:',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    env:',
    "      CI: 'true'",
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: pnpm/action-setup@v4',
    '        with:',
    '          version: 11.10.0',
    '      - uses: actions/setup-node@v4',
    '        with:',
    "          node-version: '22'",
    "          cache: 'pnpm'",
    '      - run: pnpm install',
    '      - run: pnpm exec tsc --noEmit -p tsconfig.json',
    '      - uses: grafana/setup-k6-action@v1',
    `      - run: mkdir -p outputs/k6/${project}`,
    '      - run: pnpm exec dotenvx run -f .env -- k6 run automations/specs/<section>/e2e.spec.ts',
    '',
  ].join('\n');
}

function buildK6Readme(project: string): string {
  return [
    `# ${project} (standalone)`,
    '',
    'A self-contained k6 performance-test project. It was exported from a larger',
    'workspace and carries its own shared resources and type dependencies, so it',
    'runs on its own machine with no access to the original workspace.',
    '',
    '## Requirements',
    '',
    '- k6 1.x — install it yourself; it is an external binary, not a Node dependency.',
    '  See the k6 install guide: grafana.com/docs/k6/latest/set-up/install-k6',
    '  (scoop install k6 on Windows, brew install k6 on macOS, apt/dnf on Linux).',
    '- Node.js 20+ and pnpm (`corepack enable` provides pnpm) — only for type-check',
    '  and the bundled `dotenvx` loader.',
    '',
    '## Setup',
    '',
    '```sh',
    'pnpm install',
    '```',
    '',
    'Then create your environment file from the template and fill in the values:',
    '',
    '```sh',
    'cp .env.template .env   # Windows: copy .env.template .env',
    '```',
    '',
    'Every key in `.env.template` is optional (blank = a built-in default); the',
    'inline comments explain each one.',
    '',
    '## Run',
    '',
    'k6 1.x runs a `.ts` spec directly. Pick the section you want and run its',
    'entry spec through `dotenvx` so `.env` is loaded:',
    '',
    '```sh',
    'dotenvx run -f .env -- k6 run automations/specs/<section>/e2e.spec.ts',
    '```',
    '',
    'Replace `<section>` with a real folder under `automations/specs/` (each holds',
    'an `e2e.spec.ts`). Tune the load profile through the `.env` keys documented in',
    '`.env.template` (VUs, RPS, stages, thresholds).',
    '',
    '## Type-check',
    '',
    '```sh',
    'pnpm typecheck',
    '```',
    '',
    '## Results',
    '',
    'The HTML + JSON summary are written under `outputs/k6/` when `CI=true`, and to',
    'the current folder otherwise.',
    '',
    '## Continuous integration',
    '',
    'A ready-to-run GitHub Actions workflow lives at `.github/workflows/ci.yml`',
    '(pnpm install → type-check → install k6 → run). A `Dockerfile` based on the',
    'official k6 image is included. Both name a placeholder `<section>` you edit to',
    'the section you want to run. A re-export from the workspace will not overwrite',
    'them.',
    '',
    '## Layout',
    '',
    '- `automations/` — specs and test data, grouped by section.',
    '- `src/` — project-local config that wires the shared library.',
    '- `resources/` — the shared k6 library this project depends on (copied in, so',
    '  it is self-contained). Imports resolve via relative paths, unchanged from the',
    '  workspace layout.',
    '- `.standalone.json` — marks this folder as an export and records where it came',
    '  from. Pointing the workspace exporter at this same folder again UPDATES the',
    '  code and `resources/` in place while keeping your `.env` and CI untouched.',
    '',
  ].join('\n');
}

const k6Strategy: StandaloneStrategy = {
  copyEntries: ['automations', 'src', 'docs'],
  resolveSource(type, project) {
    return resolveToolSource('k6', type, project);
  },
  rewrite(targetDir, ctx) {
    rewriteK6ResourceImports(targetDir);
    rewriteK6FileManagementOutputDir(targetDir, ctx.project);
  },
  generateFiles(targetDir, ctx, mode) {
    const written: string[] = [];
    fs.writeFileSync(path.join(targetDir, 'tsconfig.json'), buildK6Tsconfig(), 'utf8');
    fs.writeFileSync(path.join(targetDir, 'package.json'), buildK6PackageJson(ctx.project), 'utf8');
    fs.writeFileSync(path.join(targetDir, '.gitignore'), buildK6Gitignore(ctx.project), 'utf8');
    fs.writeFileSync(path.join(targetDir, 'Dockerfile'), buildK6Dockerfile(), 'utf8');
    written.push('tsconfig.json', 'package.json', '.gitignore', 'Dockerfile');
    fs.writeFileSync(path.join(targetDir, 'README.md'), buildK6Readme(ctx.project), 'utf8');
    written.push('README.md');
    const outDir = path.join(targetDir, 'outputs', 'k6', ctx.project);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, '.gitkeep'), '', 'utf8');
    written.push(`outputs/k6/${ctx.project}/.gitkeep`);
    if (mode === 'fresh') {
      const ciDir = path.join(targetDir, '.github', 'workflows');
      fs.mkdirSync(ciDir, { recursive: true });
      fs.writeFileSync(path.join(ciDir, 'ci.yml'), buildK6CiWorkflow(ctx.project), 'utf8');
      written.push('.github/workflows/ci.yml');
    }
    return written;
  },
  installDeps(targetDir) {
    return pnpmInstallIgnoreWorkspace(targetDir);
  },
};

async function uvSync(targetDir: string): Promise<{ code: string; message: string } | undefined> {
  const res = await runChild('uv', ['sync'], {
    cwd: targetDir,
    shell: RUN_SHELL,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (res.ok) return undefined;
  return {
    code: 'INSTALL_FAILED',
    message: res.output.trim() || `uv sync failed (exit ${res.code})`,
  };
}

function toPep508Name(project: string): string {
  const slug = project
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'standalone-robot-project';
}

function buildRobotPyproject(project: string): string {
  return [
    '[project]',
    `name = "${toPep508Name(project)}"`,
    'version = "1.0.0"',
    'description = "Standalone Robot Framework project exported from a larger workspace"',
    'requires-python = ">=3.14"',
    '',
    'dependencies = [',
    '  "robotframework-appiumlibrary>=3.2.1",',
    '  "robotframework-browser-batteries>=19.15.0",',
    '  "robotframework-browser>=19.15.0",',
    '  "robotframework-pabot>=5.2.2",',
    '  "robotframework>=7.4.2",',
    '  "rpaframework>=32.0.0",',
    ']',
    '',
    '[dependency-groups]',
    'dev = ["robotframework-robocop>=8.2.8"]',
    '',
    '[tool.uv]',
    'link-mode = "copy"',
    '',
  ].join('\n');
}

function buildRobotGitignore(): string {
  return ['.venv/', 'outputs/', '.env', '.robotcode_cache/', '.robocop_cache/', ''].join('\n');
}

function buildRobotDockerfile(): string {
  return [
    'FROM python:3.14-slim',
    'COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/',
    'WORKDIR /app',
    'COPY pyproject.toml uv.lock* ./',
    'ENV UV_COMPILE_BYTECODE=1',
    'RUN uv sync',
    'COPY . .',
    'RUN uv run rfbrowser init chromium',
    'CMD ["uv", "run", "robot", "-d", "outputs", "automations/specs"]',
    '',
  ].join('\n');
}

function buildRobotCiWorkflow(): string {
  return [
    'name: robot',
    'on:',
    '  push:',
    '  workflow_dispatch:',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: astral-sh/setup-uv@v5',
    '      - run: uv sync',
    '      - run: uv run rfbrowser init chromium',
    '      - run: uv run robot -d outputs automations/specs',
    '',
  ].join('\n');
}

function buildRobotReadme(project: string): string {
  return [
    `# ${project} (standalone)`,
    '',
    'A self-contained Robot Framework test project. It was exported from a larger',
    'workspace and carries its own dependencies, config, and shared resources, so',
    'it runs on its own machine with no access to the original workspace.',
    '',
    '## Requirements',
    '',
    '- Python 3.14 and uv (the Astral package manager). See docs.astral.sh/uv.',
    '- Internet access on first setup, to download dependencies and (for web tests)',
    '  the Browser-library runtime.',
    '',
    '## Setup',
    '',
    '```sh',
    'uv sync',
    '```',
    '',
    'This creates a local `.venv` and installs every dependency. For web projects',
    'that use the Browser library, also initialise its Playwright runtime once:',
    '',
    '```sh',
    'uv run rfbrowser init chromium',
    '```',
    '',
    'Desktop and API projects do not need the browser step.',
    '',
    'Then create your environment file from the template and fill in the values:',
    '',
    '```sh',
    'cp .env.template .env   # Windows: copy .env.template .env',
    '```',
    '',
    'Every key in `.env.template` is optional (blank = a built-in default); Robot',
    'reads each one via `%{KEY=default}`.',
    '',
    '## Run',
    '',
    '```sh',
    'uv run robot -d outputs automations/specs',
    '```',
    '',
    'This compiles and runs every suite under `automations/specs/`, writing the log,',
    'report, and output XML to `outputs/`. Add `--dryrun` to compile and resolve all',
    'imports without executing keywords.',
    '',
    '### Filter by tag',
    '',
    'Pass a Robot tag pattern with `-i` (include) or `-e` (exclude):',
    '',
    '```sh',
    'uv run robot -i smoke -d outputs automations/specs',
    '```',
    '',
    '### Parallel',
    '',
    'Run suites in parallel with pabot:',
    '',
    '```sh',
    'uv run pabot --processes 2 -d outputs automations/specs',
    '```',
    '',
    '## Lint / format',
    '',
    '```sh',
    'uv run robocop check --config robot.toml automations',
    'uv run robocop format --config robot.toml automations',
    '```',
    '',
    '## Results',
    '',
    'Logs, reports, and output XML are written under `outputs/`.',
    '',
    '## Continuous integration',
    '',
    'A ready-to-run GitHub Actions workflow lives at `.github/workflows/ci.yml`',
    '(uv sync → browser init → robot). A `Dockerfile` based on the official Python',
    'image is included. Both are yours to edit; a re-export from the workspace will',
    'not overwrite them.',
    '',
    '## Layout',
    '',
    '- `automations/` — specs and reusable module resources.',
    '- `src/` — project-local setup hooks and Python helper libraries.',
    '- `resources/` — the shared library this project depends on (copied in, so it',
    '  is self-contained). Robot `Resource`/`Library` imports resolve via relative',
    '  paths, unchanged from the workspace layout.',
    '- `robot.toml` — Robocop lint/format config; it references the custom rules',
    '  under `resources/`, which resolve because `resources/` sits at the root.',
    '- `.standalone.json` — marks this folder as an export and records where it came',
    '  from. Pointing the workspace exporter at this same folder again UPDATES the',
    '  code and `resources/` in place while keeping your `.env` and CI untouched.',
    '',
  ].join('\n');
}

const robotStrategy: StandaloneStrategy = {
  copyEntries: ['automations', 'src', 'docs'],
  resolveSource(type, project) {
    return resolveToolSource('robot-framework', type, project);
  },
  rewrite() {},
  generateFiles(targetDir, ctx, mode) {
    const written: string[] = [];
    fs.writeFileSync(
      path.join(targetDir, 'pyproject.toml'),
      buildRobotPyproject(ctx.project),
      'utf8',
    );
    written.push('pyproject.toml');
    const robotTomlFrom = path.join(TOOLS_DIR, 'robot-framework', 'robot.toml');
    if (fs.existsSync(robotTomlFrom)) {
      fs.copyFileSync(robotTomlFrom, path.join(targetDir, 'robot.toml'));
      written.push('robot.toml');
    }
    const pyVersionFrom = path.join(WORKSPACE_ROOT, '.python-version');
    if (fs.existsSync(pyVersionFrom)) {
      fs.copyFileSync(pyVersionFrom, path.join(targetDir, '.python-version'));
      written.push('.python-version');
    }
    fs.writeFileSync(path.join(targetDir, '.gitignore'), buildRobotGitignore(), 'utf8');
    fs.writeFileSync(path.join(targetDir, 'Dockerfile'), buildRobotDockerfile(), 'utf8');
    written.push('.gitignore', 'Dockerfile');
    fs.writeFileSync(path.join(targetDir, 'README.md'), buildRobotReadme(ctx.project), 'utf8');
    written.push('README.md');
    if (mode === 'fresh') {
      const ciDir = path.join(targetDir, '.github', 'workflows');
      fs.mkdirSync(ciDir, { recursive: true });
      fs.writeFileSync(path.join(ciDir, 'ci.yml'), buildRobotCiWorkflow(), 'utf8');
      written.push('.github/workflows/ci.yml');
    }
    return written;
  },
  installDeps(targetDir) {
    return uvSync(targetDir);
  },
};

const STRATEGIES: Record<string, StandaloneStrategy> = {
  playwright: playwrightStrategy,
  k6: k6Strategy,
  'robot-framework': robotStrategy,
};

const SUPPORTED = new Set(Object.keys(STRATEGIES));

export function isStandaloneSupported(tool: string): boolean {
  return SUPPORTED.has(tool);
}

function copyProjectFiles(
  strategy: StandaloneStrategy,
  source: StandaloneSource,
  targetDir: string,
  copyEnv: boolean,
): string[] {
  const written: string[] = [];
  for (const entry of strategy.copyEntries) {
    const from = path.join(source.projectDir, entry);
    if (!fs.existsSync(from)) continue;
    copyTree(from, path.join(targetDir, entry));
    written.push(entry);
  }
  const tplFrom = path.join(source.projectDir, '.env.template');
  if (fs.existsSync(tplFrom)) {
    fs.copyFileSync(tplFrom, path.join(targetDir, '.env.template'));
    written.push('.env.template');
  }
  if (copyEnv) {
    const envFrom = path.join(source.projectDir, '.env');
    if (fs.existsSync(envFrom)) {
      fs.copyFileSync(envFrom, path.join(targetDir, '.env'));
      written.push('.env');
    }
  }
  return written;
}

function writeEmbedKey(targetDir: string, tool: string, type: string, project: string): void {
  const key: EmbedKey = {
    sourceProject: project,
    tool,
    type,
    exportedFrom: path.basename(WORKSPACE_ROOT),
    exportedAt: new Date().toISOString(),
    workspaceVersion: readWorkspaceVersion(),
    schema: EMBED_SCHEMA,
  };
  fs.writeFileSync(
    path.join(targetDir, EMBED_KEY_FILE),
    `${JSON.stringify(key, null, 2)}\n`,
    'utf8',
  );
}

export async function exportProjectStandalone(
  opts: StandaloneOptions,
): Promise<StandaloneError | LifecycleResult<StandaloneExport>> {
  const { tool, type, project, targetDir, onStage } = opts;

  onStage?.('validate');
  const strategy = STRATEGIES[tool];
  if (!strategy) {
    return {
      code: 'TOOL_NOT_SUPPORTED',
      message: `Standalone export is not yet supported for tool '${tool}'`,
    };
  }

  const source = strategy.resolveSource(type, project);
  if ('code' in source) return source;

  let mode: 'fresh' | 'migrate' = 'fresh';
  if (isNonEmptyDir(targetDir)) {
    const existing = readEmbedKey(targetDir);
    if (!existing) {
      return {
        code: 'TARGET_NOT_EMPTY',
        message: `${targetDir} is not empty and is not a standalone export — refusing to overwrite`,
      };
    }
    if (existing.tool !== tool) {
      return {
        code: 'TARGET_TOOL_MISMATCH',
        message: `${targetDir} is a standalone export for tool '${existing.tool}', not '${tool}'`,
      };
    }
    mode = 'migrate';
  }

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const written: string[] = [];
    const ctx: StandaloneContext = { tool, type, project };

    onStage?.('copy-project');
    written.push(...copyProjectFiles(strategy, source, targetDir, mode === 'fresh'));

    onStage?.('copy-resources');
    copyTree(source.resourcesDir, path.join(targetDir, 'resources'));
    written.push('resources');

    onStage?.('rewrite');
    strategy.rewrite(targetDir, ctx);

    onStage?.('generate');
    written.push(...strategy.generateFiles(targetDir, ctx, mode));

    onStage?.('embed-key');
    writeEmbedKey(targetDir, tool, type, project);
    written.push(EMBED_KEY_FILE);

    onStage?.('install');
    const installError = await strategy.installDeps(targetDir);

    const result: StandaloneExport = {
      tool,
      type,
      project,
      targetDir,
      mode,
      written,
      ...(installError ? { installError } : {}),
    };
    return { result, resynced: false, regeneratedFiles: [] };
  } catch (err) {
    return {
      code: 'EXPORT_FAILED',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
