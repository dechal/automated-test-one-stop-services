import fs from 'node:fs';
import path from 'node:path';
import { findK6Entry, readToolDependencies, rewriteK6DayjsImportsIn } from './bundle.js';
import { readNodeVersion } from './runtimes.js';
import { K6_DOCKER_IMAGE, readToolPackageVersions } from './standalone.js';

export const CI_CHOICES = ['none', 'gitlab', 'github', 'both'] as const;
export type CiChoice = (typeof CI_CHOICES)[number];
export type CiProvider = 'gitlab' | 'github';
export type CiKind = 'standalone' | 'bundle';

export interface CiError {
  readonly code: 'INVALID_CI' | 'CI_NOT_SUPPORTED' | 'ENTRY_NOT_FOUND';
  readonly message: string;
}
export interface CiContext {
  readonly workspaceRoot: string;
  readonly tool: string;
  readonly type: string;
  readonly project: string;
  readonly targetDir: string;
  readonly kind: CiKind;
}
export interface CiSpec {
  readonly runner: 'linux' | 'windows';
  readonly dockerfile: string | null;
  readonly windowsCommand: string;
  readonly artifacts: readonly string[];
  readonly readme: readonly string[];
}
interface CiStrategy {
  readonly kinds: readonly CiKind[];
  spec(ctx: CiContext): CiSpec | CiError;
}
export interface CiGenerated {
  readonly files: readonly string[];
  readonly readme: readonly string[];
}

export const GITLAB_CI_FILE = '.gitlab-ci.yml';
export const GITHUB_WORKFLOW_FILE = '.github/workflows/test.yml';
export const LEGACY_GITHUB_WORKFLOW_FILE = '.github/workflows/ci.yml';
const DOCKERFILE = 'Dockerfile';
const DOCKERIGNORE = '.dockerignore';
const ENV_TEMPLATE = '.env.template';
const OUTPUTS_DIR = 'outputs';
const APP_DIR = '/app';
const CI_IMAGE = 'ci-test';
const CI_CONTAINER = 'ci-test-run';
const DOCKER_IMAGE = 'docker:27';
const DOCKER_DIND = 'docker:27-dind';
const ARTIFACT_EXPIRY = '1 week';
const JOB_TIMEOUT_MINUTES = 60;
const CHECKOUT_ACTION = 'actions/checkout@v4';
const UPLOAD_ACTION = 'actions/upload-artifact@v4';
const GITHUB_LINUX_RUNNER = 'ubuntu-latest';
const GITHUB_WINDOWS_RUNNER = '[self-hosted, windows]';
const GITLAB_WINDOWS_TAG = 'windows';
const PYWINAUTO_CI_ARGS = '-rA';
const ROBOT_PLAYWRIGHT_FALLBACK = '1.63.0';
const ROBOT_UV_FALLBACK = '0.11.8';
const DOCKERIGNORE_ENTRIES = [
  '.env',
  '.git',
  'node_modules',
  '.venv',
  'runtime',
  'outputs',
  'test-results',
  'playwright-report',
  'blob-report',
  '__pycache__',
  '.pytest_cache',
];
const ENV_KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const COPY_ENV_TEMPLATE = `RUN if [ -f ${ENV_TEMPLATE} ] && [ ! -f .env ]; then cp ${ENV_TEMPLATE} .env; fi`;

export function parseCiChoice(value: unknown): CiChoice | null {
  if (value === undefined || value === '') return 'none';
  if (typeof value !== 'string') return null;
  return (CI_CHOICES as readonly string[]).includes(value) ? (value as CiChoice) : null;
}

export function ciProviders(choice: CiChoice): CiProvider[] {
  if (choice === 'both') return ['gitlab', 'github'];
  return choice === 'none' ? [] : [choice];
}

export function readEnvTemplateKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const key = ENV_KEY_LINE.exec(line)?.[1];
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

function readTargetEnvKeys(targetDir: string): string[] {
  const file = path.join(targetDir, ENV_TEMPLATE);
  return fs.existsSync(file) ? readEnvTemplateKeys(fs.readFileSync(file, 'utf8')) : [];
}

function readRobotImages(workspaceRoot: string): { base: string; uv: string } {
  let text = '';
  try {
    text = fs.readFileSync(
      path.join(workspaceRoot, 'tools', 'robot-framework', 'Dockerfile'),
      'utf8',
    );
  } catch {
    text = '';
  }
  const pw = /ARG PLAYWRIGHT_VERSION=([\w.-]+)/.exec(text)?.[1] ?? ROBOT_PLAYWRIGHT_FALLBACK;
  const uv = /COPY --from=ghcr\.io\/astral-sh\/uv:([\w.-]+)/.exec(text)?.[1] ?? ROBOT_UV_FALLBACK;
  return {
    base: `mcr.microsoft.com/playwright/python:v${pw}-noble`,
    uv: `ghcr.io/astral-sh/uv:${uv}`,
  };
}

const linuxReadme = [
  'The pipeline builds `Dockerfile` and runs the tests inside that container. `.env` is never',
  'copied into the image (`.dockerignore`): the container starts from `.env.template`, and the',
  'CI variables listed below override it.',
];

const playwrightCi: CiStrategy = {
  kinds: ['standalone', 'bundle'],
  spec(ctx) {
    const v = readToolPackageVersions(ctx.workspaceRoot, 'playwright');
    return {
      runner: 'linux',
      dockerfile: [
        `FROM mcr.microsoft.com/playwright:v${v.playwright}-noble`,
        `RUN corepack enable && corepack prepare ${v.packageManager} --activate`,
        `WORKDIR ${APP_DIR}`,
        'COPY . .',
        'RUN pnpm install --ignore-workspace --frozen-lockfile || pnpm install --ignore-workspace --no-frozen-lockfile',
        COPY_ENV_TEMPLATE,
        'CMD ["pnpm", "test"]',
        '',
      ].join('\n'),
      windowsCommand: '',
      artifacts: [OUTPUTS_DIR],
      readme: [...linuxReadme, 'Reports and traces are published from `outputs/playwright/`.'],
    };
  },
};

const k6Ci: CiStrategy = {
  kinds: ['standalone', 'bundle'],
  spec(ctx) {
    rewriteK6DayjsImportsIn(ctx.targetDir);
    const entry = findK6Entry(ctx.targetDir);
    if (!entry) {
      return { code: 'ENTRY_NOT_FOUND', message: `no k6 e2e.spec.ts found in ${ctx.project}` };
    }
    const deps = Object.entries(readToolDependencies(ctx.workspaceRoot, 'k6')).map(
      ([name, range]) => `"${name}@${range}"`,
    );
    const summary = `${OUTPUTS_DIR}/k6/${ctx.project}`;
    return {
      runner: 'linux',
      dockerfile: [
        `FROM node:${readNodeVersion(ctx.workspaceRoot)}-slim AS deps`,
        'WORKDIR /deps',
        ...(deps.length > 0
          ? [`RUN npm install --no-save --no-package-lock ${deps.join(' ')}`]
          : ['RUN mkdir -p node_modules']),
        `FROM ${K6_DOCKER_IMAGE}`,
        'USER root',
        `WORKDIR ${APP_DIR}`,
        'COPY . .',
        'COPY --from=deps /deps/node_modules ./node_modules',
        `RUN mkdir -p ${summary} && chown -R k6 ${OUTPUTS_DIR}`,
        'USER k6',
        'ENTRYPOINT ["k6"]',
        `CMD ["run", "-e", "SUMMARY_DIR=${summary}", "${entry}"]`,
        '',
      ].join('\n'),
      windowsCommand: '',
      artifacts: [OUTPUTS_DIR],
      readme: [
        ...linuxReadme,
        `The container runs \`k6 run ${entry}\`. The HTML + JSON summary is published from`,
        `\`${summary}/\`. \`dayjs\` imports point at \`node_modules/dayjs/\` so k6 can load them.`,
      ],
    };
  },
};

const robotCi: CiStrategy = {
  kinds: ['standalone', 'bundle'],
  spec(ctx) {
    const images = readRobotImages(ctx.workspaceRoot);
    return {
      runner: 'linux',
      dockerfile: [
        `FROM ${images.base}`,
        `COPY --from=${images.uv} /uv /uvx /bin/`,
        `WORKDIR ${APP_DIR}`,
        'ENV UV_COMPILE_BYTECODE=1',
        'COPY . .',
        'RUN uv sync --frozen || uv sync',
        'RUN uv run rfbrowser init --skip-browsers',
        COPY_ENV_TEMPLATE,
        `CMD ["uv", "run", "robot", "-d", "${OUTPUTS_DIR}", "automations/specs"]`,
        '',
      ].join('\n'),
      windowsCommand: '',
      artifacts: [OUTPUTS_DIR],
      readme: [...linuxReadme, 'Robot logs, reports and output XML are published from `outputs/`.'],
    };
  },
};

const pywinautoCi: CiStrategy = {
  kinds: ['bundle'],
  spec() {
    return {
      runner: 'windows',
      dockerfile: null,
      windowsCommand: `run.bat ${PYWINAUTO_CI_ARGS}`,
      artifacts: [OUTPUTS_DIR],
      readme: [
        'pywinauto drives a live Windows desktop, so there is no Linux container. The pipeline runs',
        `\`run.bat ${PYWINAUTO_CI_ARGS}\` from this offline bundle on a Windows runner with an unlocked`,
        'desktop session and the application under test installed. GitLab picks a runner tagged',
        `\`${GITLAB_WINDOWS_TAG}\`. GitHub uses \`runs-on: ${GITHUB_WINDOWS_RUNNER}\`; change it to`,
        '`windows-latest` only if the hosted runner can reach the application.',
        '`run.bat` loads `.env` only when it exists, so CI variables reach the tests directly.',
      ],
    };
  },
};

const CI_STRATEGIES: Readonly<Record<string, CiStrategy>> = {
  k6: k6Ci,
  playwright: playwrightCi,
  'robot-framework': robotCi,
  pywinauto: pywinautoCi,
};

export function isCiSupported(tool: string, kind: CiKind): boolean {
  return Object.hasOwn(CI_STRATEGIES, tool) && (CI_STRATEGIES[tool]?.kinds.includes(kind) ?? false);
}

export function checkCiOption(
  value: unknown,
  tool: string,
  kind: CiKind,
): CiError | { readonly choice: CiChoice } {
  const choice = parseCiChoice(value);
  if (choice === null) {
    return { code: 'INVALID_CI', message: `ci must be one of ${CI_CHOICES.join(', ')}` };
  }
  if (choice !== 'none' && !isCiSupported(tool, kind)) {
    return {
      code: 'CI_NOT_SUPPORTED',
      message:
        tool === 'pywinauto' && kind === 'standalone'
          ? 'CI for pywinauto needs the offline bundle (Windows runner): use export-bundle'
          : `CI export is not supported for tool '${tool}' (${kind})`,
    };
  }
  return { choice };
}

export function renderDockerignore(): string {
  return `${DOCKERIGNORE_ENTRIES.join('\n')}\n`;
}

function linuxRunScript(keys: readonly string[], artifacts: readonly string[]): string[] {
  const envArgs = ['CI', ...keys].map((k) => `-e ${k}`).join(' ');
  return [
    'EXIT_CODE=0',
    `docker build -t ${CI_IMAGE} .`,
    `docker run --name ${CI_CONTAINER} ${envArgs} ${CI_IMAGE} || EXIT_CODE=$?`,
    ...artifacts.map(
      (dir) => `rm -rf ${dir} && docker cp ${CI_CONTAINER}:${APP_DIR}/${dir} ${dir} || true`,
    ),
    `docker rm ${CI_CONTAINER} || true`,
    'exit "$EXIT_CODE"',
  ];
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function renderGitlabCi(spec: CiSpec, keys: readonly string[]): string {
  const paths = spec.artifacts.map((dir) => `      - ${yamlString(`${dir}/`)}`);
  const artifacts = [
    '  artifacts:',
    '    when: always',
    `    expire_in: ${yamlString(ARTIFACT_EXPIRY)}`,
    '    paths:',
    ...paths,
  ];
  if (spec.runner === 'windows') {
    return [
      'stages:',
      '  - test',
      'test:',
      '  stage: test',
      '  tags:',
      `    - ${GITLAB_WINDOWS_TAG}`,
      '  script:',
      `    - ${yamlString(`cmd /c ${spec.windowsCommand}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`)}`,
      ...artifacts,
      '',
    ].join('\n');
  }
  return [
    'stages:',
    '  - test',
    'test:',
    '  stage: test',
    `  image: ${DOCKER_IMAGE}`,
    '  services:',
    `    - ${DOCKER_DIND}`,
    '  variables:',
    `    DOCKER_TLS_CERTDIR: ${yamlString('/certs')}`,
    '  script:',
    ...linuxRunScript(keys, spec.artifacts).map((line) => `    - ${yamlString(line)}`),
    ...artifacts,
    '',
  ].join('\n');
}

export function renderGithubWorkflow(spec: CiSpec, keys: readonly string[]): string {
  const windows = spec.runner === 'windows';
  const env =
    keys.length > 0
      ? ['    env:', ...keys.map((k) => `      ${k}: \${{ secrets.${k} || vars.${k} }}`)]
      : [];
  const run = windows
    ? ['      - name: Run tests', '        shell: cmd', `        run: ${spec.windowsCommand}`]
    : [
        '      - name: Run tests',
        '        shell: bash',
        '        run: |',
        ...linuxRunScript(keys, spec.artifacts).map((line) => `          ${line}`),
      ];
  return [
    'name: test',
    'on:',
    '  push:',
    '  pull_request:',
    '  workflow_dispatch:',
    'jobs:',
    '  test:',
    `    runs-on: ${windows ? GITHUB_WINDOWS_RUNNER : GITHUB_LINUX_RUNNER}`,
    `    timeout-minutes: ${JOB_TIMEOUT_MINUTES}`,
    ...env,
    '    steps:',
    `      - uses: ${CHECKOUT_ACTION}`,
    ...run,
    '      - name: Upload results',
    '        if: always()',
    `        uses: ${UPLOAD_ACTION}`,
    '        with:',
    '          name: test-results',
    '          path: |',
    ...spec.artifacts.map((dir) => `            ${dir}/`),
    '          if-no-files-found: warn',
    '',
  ].join('\n');
}

function ciReadme(
  spec: CiSpec,
  providers: readonly CiProvider[],
  keys: readonly string[],
): string[] {
  const files = providers.map((p) =>
    p === 'gitlab'
      ? `GitLab CI (\`${GITLAB_CI_FILE}\`)`
      : `GitHub Actions (\`${GITHUB_WORKFLOW_FILE}\`)`,
  );
  return [
    '',
    '## CI/CD',
    '',
    `This export ships a pipeline for ${files.join(' and ')}.`,
    '',
    ...spec.readme,
    '',
    'Results are published as a pipeline artifact, also when tests fail.',
    ...(spec.runner === 'linux' && providers.includes('gitlab')
      ? ['', 'GitLab needs a runner that allows Docker-in-Docker (`privileged = true`).']
      : []),
    '',
    'Set these keys as CI variables, named exactly as in `.env.template` (GitLab: Settings >',
    'CI/CD > Variables; GitHub: repository secrets or variables). A key left unset uses the',
    'template default:',
    '',
    ...(keys.length > 0 ? keys.map((k) => `- \`${k}\``) : ['- (none)']),
    '',
  ];
}

export function generateCiFiles(ctx: CiContext, choice: CiChoice): CiError | CiGenerated {
  const providers = ciProviders(choice);
  if (providers.length === 0) return { files: [], readme: [] };
  const strategy = Object.hasOwn(CI_STRATEGIES, ctx.tool) ? CI_STRATEGIES[ctx.tool] : undefined;
  if (!strategy?.kinds.includes(ctx.kind)) {
    return {
      code: 'CI_NOT_SUPPORTED',
      message: `CI export is not supported for tool '${ctx.tool}'`,
    };
  }
  const spec = strategy.spec(ctx);
  if ('code' in spec) return spec;
  const keys = readTargetEnvKeys(ctx.targetDir);
  const files: string[] = [];
  const write = (rel: string, text: string): void => {
    const file = path.join(ctx.targetDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    files.push(rel);
  };
  if (spec.dockerfile !== null) {
    write(DOCKERFILE, spec.dockerfile);
    write(DOCKERIGNORE, renderDockerignore());
  }
  if (providers.includes('gitlab')) write(GITLAB_CI_FILE, renderGitlabCi(spec, keys));
  if (providers.includes('github')) {
    fs.rmSync(path.join(ctx.targetDir, LEGACY_GITHUB_WORKFLOW_FILE), { force: true });
    write(GITHUB_WORKFLOW_FILE, renderGithubWorkflow(spec, keys));
  }
  return { files, readme: ciReadme(spec, providers, keys) };
}

export function appendCiReadme(targetDir: string, lines: readonly string[]): void {
  if (lines.length === 0) return;
  fs.appendFileSync(path.join(targetDir, 'README.md'), lines.join('\n'), 'utf8');
}

export function mergeWritten(written: readonly string[], ci: CiGenerated): string[] {
  const legacyGone = ci.files.includes(GITHUB_WORKFLOW_FILE);
  const kept = written.filter((f) => !(legacyGone && f === LEGACY_GITHUB_WORKFLOW_FILE));
  return [...kept, ...ci.files.filter((f) => !kept.includes(f))];
}
