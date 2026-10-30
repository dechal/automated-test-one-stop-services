import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Exec, runChild } from './exec.js';
import { buildRunBat, LAUNCHER_FILE, type LauncherSpec } from './launcher.js';
import {
  DEFAULT_PLATFORM,
  type FetchFn,
  type PlatformId,
  PYTHON_INSTALL_TIMEOUT_MS,
  RUNTIMES,
  type RuntimeId,
  resolveRuntimeVersion,
  runtimeNote,
  systemTar,
  TESSERACT_EXE,
  TESSERACT_LANGS,
  vendorPython,
  vendorRuntime,
  vendorTesseract,
} from './runtimes.js';
import {
  copyProjectFiles,
  copyTree,
  EMBED_SCHEMA,
  type EmbedKey,
  getStandaloneStrategy,
  isNonEmptyDir,
  type LifecycleResult,
  readWorkspaceVersion,
  type StandaloneContext,
  type StandaloneError,
  type StandaloneExport,
} from './standalone.js';
import { checkTargetPath, isSafeIdent, MAX_TARGET_PATH } from './validate.js';

export const BUNDLE_KEY_FILE = '.bundle.json';
export const BUNDLE_KIND = 'bundle';
export const K6_SUMMARY_ENV = 'SUMMARY_DIR';

const ENV_FILE = '.env';
const RUNTIME_DIR = 'runtime';
const INSTALL_TIMEOUT_MS = 600_000;
const INSTALL_TAIL_LINES = 20;
const RUN_SHELL = process.platform === 'win32';

export const BUNDLE_STAGES = [
  'validate',
  'copy-project',
  'copy-resources',
  'rewrite',
  'generate',
  'embed-key',
  'fetch-runtimes',
  'install-deps',
  'browsers',
  'launcher',
  'verify-layout',
  'zip',
] as const;

export type BundleStage = (typeof BUNDLE_STAGES)[number];

export type BundleErrorCode =
  | StandaloneError['code']
  | 'INVALID_IDENT'
  | 'INVALID_TARGET'
  | 'ENTRY_NOT_FOUND'
  | 'RUNTIME_FETCH_FAILED'
  | 'RUNTIME_EXTRACT_FAILED'
  | 'DEPS_INSTALL_FAILED'
  | 'BROWSERS_FAILED'
  | 'TESSERACT_NOT_FOUND'
  | 'TESSDATA_MISSING'
  | 'BUNDLE_INCOMPLETE';

export interface BundleError {
  readonly code: BundleErrorCode;
  readonly message: string;
}

export interface BundleOptions {
  readonly workspaceRoot: string;
  readonly tool: string;
  readonly type: string;
  readonly project: string;
  readonly targetDir: string;
  readonly withEnv?: boolean;
  readonly zip?: boolean;
  readonly onStage?: (stage: BundleStage) => void;
  readonly log?: (line: string) => void;
  readonly exec?: Exec;
  readonly fetch?: FetchFn;
  readonly platform?: PlatformId;
}

export interface BundleExport extends StandaloneExport {
  readonly kind: typeof BUNDLE_KIND;
  readonly platform: PlatformId;
  readonly runtimes: Readonly<Record<string, string>>;
  readonly entry: string | null;
  readonly sizeBytes: number;
  readonly envIncluded: boolean;
  readonly zipPath?: string;
  readonly zipError?: { readonly code: string; readonly message: string };
}

export interface BundleKey extends EmbedKey {
  readonly kind: typeof BUNDLE_KIND;
  readonly platform: PlatformId;
  readonly runtimes: Readonly<Record<string, string>>;
  readonly entry: string | null;
}

export interface BundleContext {
  readonly workspaceRoot: string;
  readonly tool: string;
  readonly type: string;
  readonly project: string;
  readonly targetDir: string;
  readonly platform: PlatformId;
  readonly exec: Exec;
  readonly log: (line: string) => void;
}

export interface BundlePrepared {
  readonly entry: string | null;
}

export interface BundleVendored {
  readonly runtimes: Readonly<Record<string, string>>;
}

export interface BundleStrategy {
  readonly runtimes: readonly RuntimeId[];
  vendor?(ctx: BundleContext): Promise<BundleError | BundleVendored>;
  rewrite(ctx: BundleContext): void;
  generate(ctx: BundleContext): BundleError | BundlePrepared;
  installDeps(ctx: BundleContext): Promise<BundleError | undefined>;
  installBrowsers(ctx: BundleContext): Promise<BundleError | undefined>;
  launcher(ctx: BundleContext, prepared: BundlePrepared): LauncherSpec;
  requiredPaths(ctx: BundleContext, prepared: BundlePrepared): string[];
  readme(ctx: BundleContext, prepared: BundlePrepared): string[];
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function tailLines(text: string, count: number): string {
  return text.trim().split(/\r?\n/).slice(-count).join('\n');
}

function walkFiles(dir: string, accept: (name: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...walkFiles(full, accept));
    } else if (accept(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function dirSize(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readStringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
  return out;
}

const DAYJS_IMPORT =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])dayjs(?:\/plugin\/([A-Za-z0-9]+)(?:\.js)?)?\2/g;
const DAYJS_MAIN_FILE = 'dayjs.min.js';

export function rewriteDayjsImports(source: string, fileDir: string, targetDir: string): string {
  return source.replace(DAYJS_IMPORT, (_m, prefix: string, quote: string, plugin?: string) => {
    const file = plugin ? path.join('plugin', `${plugin}.js`) : DAYJS_MAIN_FILE;
    const rel = toPosix(
      path.relative(fileDir, path.join(targetDir, 'node_modules', 'dayjs', file)),
    );
    return `${prefix}${quote}${rel.startsWith('.') ? rel : `./${rel}`}${quote}`;
  });
}

const K6_REWRITE_DIRS = ['resources', 'src', 'automations'];
const K6_ENTRY_FILE = 'e2e.spec.ts';
const K6_SPECS_DIR = path.join('automations', 'specs');

export function findK6Entry(targetDir: string): string | null {
  const found = walkFiles(path.join(targetDir, K6_SPECS_DIR), (n) => n === K6_ENTRY_FILE)
    .map((f) => toPosix(path.relative(targetDir, f)))
    .sort();
  return found[0] ?? null;
}

function readToolDependencies(workspaceRoot: string, tool: string): Record<string, string> {
  const pkg = readJsonObject(path.join(workspaceRoot, 'tools', tool, 'package.json'));
  return readStringRecord(pkg?.dependencies);
}

async function pnpmInstallHoisted(
  ctx: BundleContext,
  extraArgs: readonly string[],
): Promise<BundleError | undefined> {
  const args = ['install', '--ignore-workspace', '--config.node-linker=hoisted', ...extraArgs];
  ctx.log(`pnpm ${args.join(' ')}`);
  const res = await ctx.exec('pnpm', args, {
    cwd: ctx.targetDir,
    shell: RUN_SHELL,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (res.ok) return undefined;
  return {
    code: 'DEPS_INSTALL_FAILED',
    message: tailLines(res.output, INSTALL_TAIL_LINES) || `pnpm install failed (exit ${res.code})`,
  };
}

const k6BundleStrategy: BundleStrategy = {
  runtimes: ['k6'],
  rewrite(ctx) {
    for (const dir of K6_REWRITE_DIRS) {
      for (const file of walkFiles(path.join(ctx.targetDir, dir), (n) => /\.(ts|js)$/.test(n))) {
        const before = fs.readFileSync(file, 'utf8');
        const after = rewriteDayjsImports(before, path.dirname(file), ctx.targetDir);
        if (after !== before) fs.writeFileSync(file, after, 'utf8');
      }
    }
  },
  generate(ctx) {
    const entry = findK6Entry(ctx.targetDir);
    if (!entry) {
      return {
        code: 'ENTRY_NOT_FOUND',
        message: `no ${K6_SPECS_DIR}/**/${K6_ENTRY_FILE} found in ${ctx.project}`,
      };
    }
    const pkgPath = path.join(ctx.targetDir, 'package.json');
    const pkg = readJsonObject(pkgPath) ?? {};
    const deps = readToolDependencies(ctx.workspaceRoot, ctx.tool);
    fs.writeFileSync(
      pkgPath,
      `${JSON.stringify({ ...pkg, dependencies: deps }, null, 2)}\n`,
      'utf8',
    );
    return { entry };
  },
  installDeps(ctx) {
    return pnpmInstallHoisted(ctx, ['--prod']);
  },
  async installBrowsers() {
    return undefined;
  },
  launcher(ctx, prepared) {
    const k6 = '"!B!\\runtime\\k6\\k6.exe"';
    const summary = `-e "${K6_SUMMARY_ENV}=outputs/k6/${ctx.project}"`;
    return {
      pathDirs: ['runtime\\k6'],
      env: {},
      tag: { kind: 'args', template: '-e "TAG=!TAG!"' },
      entry: { defaultPath: prepared.entry ?? '', overrideExtensions: ['.ts', '.js'] },
      command: `${k6} run !TAGARGS! ${summary} !REST! "!ENTRY!"`,
      subcommands: [{ name: 'inspect', command: `${k6} inspect !REST! "!ENTRY!"` }],
    };
  },
  requiredPaths(ctx, prepared) {
    const deps = Object.keys(readToolDependencies(ctx.workspaceRoot, ctx.tool));
    return [
      path.join(RUNTIME_DIR, 'k6', RUNTIMES.k6.binRel),
      ...(prepared.entry ? [prepared.entry] : []),
      ...deps.map((d) => path.join('node_modules', d, 'package.json')),
    ];
  },
  readme(ctx, prepared) {
    return [
      '```bat',
      'run.bat                          :: run the default entry spec',
      'run.bat --iterations 1 --vus 1   :: extra args go straight to k6 run',
      'run.bat automations\\specs\\<section>\\e2e.spec.ts   :: pick another entry spec',
      'run.bat inspect                  :: k6 inspect the entry spec (no network)',
      '```',
      '',
      `Default entry: \`${prepared.entry ?? '(none)'}\`.`,
      `\`TAG=<v>\` is passed to k6 as \`-e TAG=<v>\`; it does nothing unless a spec reads it.`,
      `The HTML + JSON summary go to \`outputs/k6/${ctx.project}/\`.`,
      'The PDF and Grafana dashboard generators need Node and are not part of this bundle.',
    ];
  },
};

export const PLAYWRIGHT_GREP_ENV = 'PLAYWRIGHT_GREP';
export const PLAYWRIGHT_BROWSERS_ENV = 'PLAYWRIGHT_BROWSERS_PATH';
export const PLAYWRIGHT_BROWSERS_CACHE_REL = path.join('.cache', 'playwright-browsers');
const PLAYWRIGHT_BROWSERS_DIR = path.join(RUNTIME_DIR, 'browsers');
const PLAYWRIGHT_CLI = path.join('node_modules', '@playwright', 'test', 'cli.js');
const PLAYWRIGHT_BROWSERS_JSON = path.join('node_modules', 'playwright-core', 'browsers.json');
const PLAYWRIGHT_CONFIG_FILE = 'playwright.config.ts';
const PLAYWRIGHT_COPY_BROWSERS = ['chromium', 'chromium-headless-shell', 'ffmpeg', 'winldd'];
const PLAYWRIGHT_REQUIRED_BROWSERS = ['chromium', 'chromium-headless-shell'];
const PLAYWRIGHT_INSTALL_BROWSER = 'chromium';
const PLAYWRIGHT_INSTALL_ARGS = ['--frozen-lockfile=false', '--config.strict-dep-builds=false'];

export function readBrowserRevisions(browsersJsonText: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(browsersJsonText);
    const list =
      parsed !== null && typeof parsed === 'object' && 'browsers' in parsed
        ? (parsed as { browsers: unknown }).browsers
        : null;
    if (!Array.isArray(list)) return {};
    const out: Record<string, string> = {};
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue;
      const { name, revision } = item as { name?: unknown; revision?: unknown };
      if (typeof name === 'string' && typeof revision === 'string') out[name] = revision;
    }
    return out;
  } catch {
    return {};
  }
}

export function browserDirName(name: string, revision: string): string {
  return `${name.replace(/-/g, '_')}-${revision}`;
}

function readBundledBrowserRevisions(targetDir: string): Record<string, string> {
  try {
    return readBrowserRevisions(
      fs.readFileSync(path.join(targetDir, PLAYWRIGHT_BROWSERS_JSON), 'utf8'),
    );
  } catch {
    return {};
  }
}

function browserDirs(revisions: Record<string, string>, names: readonly string[]): string[] {
  return names.flatMap((n) => {
    const rev = revisions[n];
    return rev ? [browserDirName(n, rev)] : [];
  });
}

const playwrightBundleStrategy: BundleStrategy = {
  runtimes: ['node'],
  rewrite() {},
  generate() {
    return { entry: null };
  },
  installDeps(ctx) {
    return pnpmInstallHoisted(ctx, PLAYWRIGHT_INSTALL_ARGS);
  },
  async installBrowsers(ctx) {
    const revisions = readBundledBrowserRevisions(ctx.targetDir);
    const required = browserDirs(revisions, PLAYWRIGHT_REQUIRED_BROWSERS);
    if (required.length !== PLAYWRIGHT_REQUIRED_BROWSERS.length) {
      return {
        code: 'BROWSERS_FAILED',
        message: `no chromium revision in ${toPosix(PLAYWRIGHT_BROWSERS_JSON)}`,
      };
    }
    const dest = path.join(ctx.targetDir, PLAYWRIGHT_BROWSERS_DIR);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    const cache = path.join(ctx.workspaceRoot, PLAYWRIGHT_BROWSERS_CACHE_REL);
    const wanted = browserDirs(revisions, PLAYWRIGHT_COPY_BROWSERS);
    if (wanted.every((d) => fs.existsSync(path.join(cache, d)))) {
      ctx.log(
        `browsers copied from ${toPosix(PLAYWRIGHT_BROWSERS_CACHE_REL)}: ${wanted.join(', ')}`,
      );
      for (const d of wanted) copyTree(path.join(cache, d), path.join(dest, d));
    } else {
      ctx.log(`browsers: cache has no ${wanted.join(', ')}; running playwright install`);
      const res = await ctx.exec(
        path.join(ctx.targetDir, RUNTIME_DIR, 'node', RUNTIMES.node.binRel),
        [path.join(ctx.targetDir, PLAYWRIGHT_CLI), 'install', PLAYWRIGHT_INSTALL_BROWSER],
        {
          cwd: ctx.targetDir,
          env: { ...process.env, [PLAYWRIGHT_BROWSERS_ENV]: dest },
          timeoutMs: INSTALL_TIMEOUT_MS,
        },
      );
      if (!res.ok) {
        return {
          code: 'BROWSERS_FAILED',
          message:
            tailLines(res.output, INSTALL_TAIL_LINES) ||
            `playwright install failed (exit ${res.code})`,
        };
      }
    }
    const missing = required.filter((d) => !fs.existsSync(path.join(dest, d)));
    if (missing.length > 0) {
      return {
        code: 'BROWSERS_FAILED',
        message: `${toPosix(PLAYWRIGHT_BROWSERS_DIR)} is missing: ${missing.join(', ')}`,
      };
    }
    return undefined;
  },
  launcher() {
    const node = '"!B!\\runtime\\node\\node.exe"';
    const cli = `"!B!\\${PLAYWRIGHT_CLI}"`;
    return {
      pathDirs: ['runtime\\node'],
      env: { [PLAYWRIGHT_BROWSERS_ENV]: `%B%\\${PLAYWRIGHT_BROWSERS_DIR}` },
      tag: { kind: 'env', name: PLAYWRIGHT_GREP_ENV },
      command: `${node} ${cli} test !REST!`,
      subcommands: [],
    };
  },
  requiredPaths(ctx) {
    const revisions = readBundledBrowserRevisions(ctx.targetDir);
    return [
      path.join(RUNTIME_DIR, 'node', RUNTIMES.node.binRel),
      PLAYWRIGHT_CLI,
      PLAYWRIGHT_BROWSERS_JSON,
      PLAYWRIGHT_CONFIG_FILE,
      ...browserDirs(revisions, PLAYWRIGHT_REQUIRED_BROWSERS).map((d) =>
        path.join(PLAYWRIGHT_BROWSERS_DIR, d),
      ),
    ];
  },
  readme() {
    return [
      '```bat',
      'run.bat                               :: run every spec headless',
      'run.bat --list                        :: list the tests, run nothing',
      'run.bat automations\\specs\\<file>.ts   :: run one spec file',
      'run.bat TAG=@smoke                    :: only tests whose title matches the regex',
      'run.bat --headed --workers 1          :: extra args go straight to playwright test',
      '```',
      '',
      `\`TAG=<regex>\` is passed to Playwright as \`${PLAYWRIGHT_GREP_ENV}\`.`,
      `Chromium ships under \`${toPosix(PLAYWRIGHT_BROWSERS_DIR)}/\` (\`${PLAYWRIGHT_BROWSERS_ENV}\`).`,
      'Reports and traces are written under `outputs/playwright/`.',
    ];
  },
};

const PYTHON_DIR = path.join(RUNTIME_DIR, 'python');
const PYTHON_EXE = path.join(PYTHON_DIR, 'python.exe');
const SITE_PACKAGES = path.join(PYTHON_DIR, 'Lib', 'site-packages');
const PYTHON_LAUNCH = '"!B!\\runtime\\python\\python.exe"';

export function readPyprojectName(text: string): string | null {
  let inProject = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inProject = line === '[project]';
      continue;
    }
    if (!inProject) continue;
    const name = line.match(/^name\s*=\s*"([^"]+)"/)?.[1];
    if (name) return name;
  }
  return null;
}

function bundlePythonEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const { PYTHONHOME: _home, PYTHONPATH: _path, VIRTUAL_ENV: _venv, ...rest } = process.env;
  return { ...rest, PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', ...extra };
}

async function vendorBundledPython(ctx: BundleContext): Promise<BundleError | BundleVendored> {
  const res = await vendorPython({
    workspaceRoot: ctx.workspaceRoot,
    runtimeDir: path.join(ctx.targetDir, PYTHON_DIR),
    platform: ctx.platform,
    exec: ctx.exec,
  });
  if ('code' in res) return res;
  ctx.log(`runtime python ${res.version}`);
  return { runtimes: { python: res.version } };
}

async function installPythonDeps(ctx: BundleContext): Promise<BundleError | undefined> {
  const pyproject = path.join(ctx.workspaceRoot, 'tools', ctx.tool, 'pyproject.toml');
  const name = fs.existsSync(pyproject)
    ? readPyprojectName(fs.readFileSync(pyproject, 'utf8'))
    : null;
  if (!name) {
    return { code: 'DEPS_INSTALL_FAILED', message: `no [project].name in ${pyproject}` };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-reqs-'));
  const reqs = path.join(tmp, 'requirements.txt');
  const steps: { label: string; args: string[] }[] = [
    {
      label: 'uv export',
      args: [
        'export',
        '--frozen',
        '--package',
        name,
        '--no-hashes',
        '--no-emit-workspace',
        '--no-dev',
        '--no-progress',
        '-o',
        reqs,
        '--project',
        path.join(ctx.workspaceRoot, 'tools', ctx.tool),
      ],
    },
    {
      label: 'uv pip install',
      args: [
        'pip',
        'install',
        '--python',
        path.join(ctx.targetDir, PYTHON_EXE),
        '--system',
        '--break-system-packages',
        '--link-mode=copy',
        '--no-progress',
        '-r',
        reqs,
      ],
    },
  ];
  try {
    for (const step of steps) {
      ctx.log(`uv ${step.args.join(' ')}`);
      const res = await ctx.exec('uv', step.args, {
        cwd: ctx.workspaceRoot,
        env: bundlePythonEnv(),
        timeoutMs: PYTHON_INSTALL_TIMEOUT_MS,
      });
      if (!res.ok) {
        return {
          code: 'DEPS_INSTALL_FAILED',
          message:
            tailLines(res.output, INSTALL_TAIL_LINES) || `${step.label} failed (exit ${res.code})`,
        };
      }
    }
    return undefined;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function runBundledPython(
  ctx: BundleContext,
  args: string[],
  env: Readonly<Record<string, string>> = {},
): Promise<{ ok: boolean; code: number; output: string }> {
  return ctx.exec(path.join(ctx.targetDir, PYTHON_EXE), args, {
    cwd: ctx.targetDir,
    env: bundlePythonEnv(env),
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
}

const TOOL_RESOURCES_PATH = /((?:\.\.\/)+)resources\//g;

export function rewriteToolResourcePaths(
  source: string,
  fileRelDir: string,
  projectRel: string,
): string {
  const workspaceDir = path.posix.join(projectRel, fileRelDir);
  return source.replace(TOOL_RESOURCES_PATH, (match, ups: string) => {
    const resolved = path.posix.normalize(path.posix.join(workspaceDir, ups, 'resources'));
    if (resolved !== 'resources') return match;
    const rel = path.posix.relative(fileRelDir === '' ? '.' : fileRelDir, 'resources');
    return `${rel}/`;
  });
}

export const ROBOT_BROWSER_TYPES: readonly string[] = ['web'];
const ROBOT_SPECS_DIR = 'automations/specs';
const ROBOT_REWRITE_DIRS = ['automations', 'src'];
const ROBOT_SOURCE_FILE = /\.(robot|resource)$/;
const ROBOT_WRAPPER_BROWSERS_JSONS = [
  path.join(SITE_PACKAGES, 'BrowserBatteries', 'bin', 'wrapper', PLAYWRIGHT_BROWSERS_JSON),
  path.join(SITE_PACKAGES, 'Browser', 'wrapper', PLAYWRIGHT_BROWSERS_JSON),
];

function robotUsesBrowser(ctx: BundleContext): boolean {
  return ROBOT_BROWSER_TYPES.includes(ctx.type.split('/')[0] ?? '');
}

function readRobotBrowserRevisions(targetDir: string): Record<string, string> {
  for (const rel of ROBOT_WRAPPER_BROWSERS_JSONS) {
    const file = path.join(targetDir, rel);
    if (fs.existsSync(file)) return readBrowserRevisions(fs.readFileSync(file, 'utf8'));
  }
  return {};
}

function robotChromiumDir(targetDir: string): string | null {
  return browserDirs(readRobotBrowserRevisions(targetDir), ['chromium'])[0] ?? null;
}

const robotBundleStrategy: BundleStrategy = {
  runtimes: [],
  vendor: vendorBundledPython,
  rewrite(ctx) {
    const projectRel = toPosix(path.join('projects', ctx.type, ctx.project));
    for (const dir of ROBOT_REWRITE_DIRS) {
      for (const file of walkFiles(path.join(ctx.targetDir, dir), (n) =>
        ROBOT_SOURCE_FILE.test(n),
      )) {
        const before = fs.readFileSync(file, 'utf8');
        const fileRelDir = toPosix(path.relative(ctx.targetDir, path.dirname(file)));
        const after = rewriteToolResourcePaths(before, fileRelDir, projectRel);
        if (after !== before) fs.writeFileSync(file, after, 'utf8');
      }
    }
  },
  generate() {
    return { entry: ROBOT_SPECS_DIR };
  },
  installDeps: installPythonDeps,
  async installBrowsers(ctx) {
    if (!robotUsesBrowser(ctx)) return undefined;
    const chromium = robotChromiumDir(ctx.targetDir);
    if (!chromium) {
      return {
        code: 'BROWSERS_FAILED',
        message: `no chromium revision in ${ROBOT_WRAPPER_BROWSERS_JSONS.map(toPosix).join(' or ')}`,
      };
    }
    const dest = path.join(ctx.targetDir, PLAYWRIGHT_BROWSERS_DIR);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    ctx.log(`browsers: python -m Browser.entry install ${PLAYWRIGHT_INSTALL_BROWSER}`);
    const res = await runBundledPython(
      ctx,
      ['-m', 'Browser.entry', 'install', PLAYWRIGHT_INSTALL_BROWSER],
      { [PLAYWRIGHT_BROWSERS_ENV]: dest },
    );
    if (!fs.existsSync(path.join(dest, chromium))) {
      const revisions = readRobotBrowserRevisions(ctx.targetDir);
      const cache = path.join(ctx.workspaceRoot, PLAYWRIGHT_BROWSERS_CACHE_REL);
      const wanted = browserDirs(revisions, PLAYWRIGHT_COPY_BROWSERS);
      if (wanted.every((d) => fs.existsSync(path.join(cache, d)))) {
        ctx.log(`browsers: install left no ${chromium}; copying ${wanted.join(', ')} from cache`);
        for (const d of wanted) copyTree(path.join(cache, d), path.join(dest, d));
      }
    }
    if (!fs.existsSync(path.join(dest, chromium))) {
      return {
        code: 'BROWSERS_FAILED',
        message: `${toPosix(PLAYWRIGHT_BROWSERS_DIR)} has no ${chromium} after Browser.entry install (exit ${res.code}) and the cache copy: ${tailLines(res.output, INSTALL_TAIL_LINES)}`,
      };
    }
    return undefined;
  },
  launcher(ctx, prepared) {
    const env: Record<string, string> = robotUsesBrowser(ctx)
      ? { [PLAYWRIGHT_BROWSERS_ENV]: `%B%\\${PLAYWRIGHT_BROWSERS_DIR}` }
      : {};
    return {
      pathDirs: ['runtime\\python'],
      env,
      tag: { kind: 'args', template: '--include "!TAG!"' },
      entry: { defaultPath: prepared.entry ?? ROBOT_SPECS_DIR, overrideExtensions: ['.robot'] },
      command: `${PYTHON_LAUNCH} -m robot !TAGARGS! -d outputs !REST! "!ENTRY!"`,
      subcommands: [],
    };
  },
  requiredPaths(ctx) {
    const chromium = robotUsesBrowser(ctx) ? robotChromiumDir(ctx.targetDir) : null;
    return [
      PYTHON_EXE,
      path.join(SITE_PACKAGES, 'robot', '__init__.py'),
      ROBOT_SPECS_DIR,
      ...(robotUsesBrowser(ctx)
        ? [
            path.join(SITE_PACKAGES, 'Browser', '__init__.py'),
            path.join(PLAYWRIGHT_BROWSERS_DIR, chromium ?? 'chromium-<rev>'),
          ]
        : []),
    ];
  },
  readme(ctx) {
    return [
      '```bat',
      'run.bat                                   :: run every suite under automations\\specs',
      'run.bat --dryrun                          :: parse and resolve every import, run nothing',
      'run.bat automations\\specs\\<dir>\\<x>.robot  :: run one suite file',
      'run.bat TAG=smoke                         :: only tests tagged smoke (--include)',
      'run.bat --loglevel DEBUG                  :: extra args go straight to robot',
      '```',
      '',
      'Logs, reports and output XML are written to `outputs/`.',
      ...(robotUsesBrowser(ctx)
        ? [
            `Chromium for the Browser library ships under \`${toPosix(PLAYWRIGHT_BROWSERS_DIR)}/\` (\`${PLAYWRIGHT_BROWSERS_ENV}\`).`,
          ]
        : []),
    ];
  },
};

export const PYWINAUTO_GREP_ENV = 'PYWINAUTO_GREP';
export const TESSDATA_ENV = 'TESSDATA_PREFIX';
const TASKFILE = 'Taskfile.yml';
const TASKFILE_UV_PYTEST = 'uv run pytest';
const TASKFILE_BUNDLED_PYTEST = '"{{.TASKFILE_DIR}}/runtime/python/python.exe" -m pytest';
const TESSERACT_DIR = path.join(RUNTIME_DIR, 'tesseract');
const SITECUSTOMIZE_FILE = path.join(SITE_PACKAGES, 'sitecustomize.py');
const COMTYPES_GEN_DIR = path.join(SITE_PACKAGES, 'comtypes', 'gen');
const TASK_LAUNCH = '"!B!\\runtime\\task\\task.exe"';
const PYWINAUTO_RUNNER = path.join('src', 'runner.py');
const PYWINAUTO_UV_LAUNCHER = 'execute.bat';

export function buildPywin32Sitecustomize(): string {
  return [
    'import os',
    'import sys',
    '',
    "PYWIN32_DLL_DIR = os.path.join(sys.prefix, 'Lib', 'site-packages', 'pywin32_system32')",
    '',
    'if os.path.isdir(PYWIN32_DLL_DIR):',
    '    os.add_dll_directory(PYWIN32_DLL_DIR)',
    '',
  ].join('\n');
}

const TASKFILE_INLINE_PYTEST_ITEM = /^(\s*)- (?!\|)(.*uv run pytest.*)$/gm;
const TASKFILE_BLOCK_ITEM = /^(\s*)- \|\r?\n(\s*)/gm;
const TASKFILE_PYTHON_UNSET = 'unset PYTHONHOME PYTHONPATH';

export function toBundledTaskfile(taskfile: string): string {
  return taskfile
    .replace(TASKFILE_INLINE_PYTEST_ITEM, '$1- |\n$1  $2')
    .replace(TASKFILE_BLOCK_ITEM, `$1- |\n$2${TASKFILE_PYTHON_UNSET}\n$2`)
    .split(TASKFILE_UV_PYTEST)
    .join(TASKFILE_BUNDLED_PYTEST);
}

const pywinautoBundleStrategy: BundleStrategy = {
  runtimes: ['task'],
  async vendor(ctx) {
    const python = await vendorBundledPython(ctx);
    if ('code' in python) return python;
    const tesseract = await vendorTesseract({
      runtimeDir: path.join(ctx.targetDir, TESSERACT_DIR),
      exec: ctx.exec,
    });
    if ('code' in tesseract) return tesseract;
    ctx.log(`runtime tesseract ${tesseract.version}`);
    return { runtimes: { ...python.runtimes, tesseract: tesseract.version } };
  },
  rewrite() {},
  generate(ctx) {
    const file = path.join(ctx.targetDir, TASKFILE);
    const bundled = toBundledTaskfile(fs.readFileSync(file, 'utf8'));
    if (bundled.includes('uv run')) {
      return { code: 'BUNDLE_INCOMPLETE', message: `${TASKFILE} still calls uv run` };
    }
    fs.writeFileSync(file, bundled, 'utf8');
    fs.rmSync(path.join(ctx.targetDir, PYWINAUTO_UV_LAUNCHER), { force: true });
    fs.rmSync(path.join(ctx.targetDir, LAUNCHER_FILE), { force: true });
    return { entry: null };
  },
  async installDeps(ctx) {
    const err = await installPythonDeps(ctx);
    if (err) return err;
    fs.writeFileSync(path.join(ctx.targetDir, SITECUSTOMIZE_FILE), buildPywin32Sitecustomize());
    ctx.log('comtypes.gen: python -c "import comtypes.client, pywinauto"');
    const res = await runBundledPython(ctx, ['-c', 'import comtypes.client, pywinauto']);
    if (!res.ok) {
      return {
        code: 'DEPS_INSTALL_FAILED',
        message:
          tailLines(res.output, INSTALL_TAIL_LINES) ||
          `import comtypes.client, pywinauto failed (exit ${res.code})`,
      };
    }
    return undefined;
  },
  async installBrowsers() {
    return undefined;
  },
  launcher(ctx) {
    const hasRunner = fs.existsSync(path.join(ctx.targetDir, PYWINAUTO_RUNNER));
    const subcommands = [{ name: 'tags', command: `${TASK_LAUNCH} pywin:tags` }];
    if (hasRunner) {
      subcommands.push({
        name: 'runner',
        command: `${PYTHON_LAUNCH} "!B!\\src\\runner.py" !REST!`,
      });
    }
    return {
      pathDirs: ['runtime\\python', 'runtime\\task', 'runtime\\tesseract'],
      env: { [TESSDATA_ENV]: `%B%\\${TESSERACT_DIR}\\tessdata` },
      tag: { kind: 'env', name: PYWINAUTO_GREP_ENV },
      command: `${TASK_LAUNCH} pywin:run-local -- !REST!`,
      subcommands,
      ...(hasRunner ? { noArgsSubcommand: 'runner' } : {}),
    };
  },
  requiredPaths() {
    return [
      PYTHON_EXE,
      path.join(SITE_PACKAGES, 'pywinauto', '__init__.py'),
      path.join(SITE_PACKAGES, 'pytest', '__init__.py'),
      SITECUSTOMIZE_FILE,
      COMTYPES_GEN_DIR,
      path.join(RUNTIME_DIR, 'task', RUNTIMES.task.binRel),
      path.join(TESSERACT_DIR, TESSERACT_EXE),
      ...TESSERACT_LANGS.map((l) => path.join(TESSERACT_DIR, 'tessdata', `${l}.traineddata`)),
      'pytest.ini',
      TASKFILE,
    ];
  },
  readme(ctx) {
    const runnerLines = fs.existsSync(path.join(ctx.targetDir, PYWINAUTO_RUNNER))
      ? [
          'Double-click `run.bat` (no arguments) to start `src/runner.py`. It reads',
          '`RUNNER_FEATURE` from `.env`: blank runs every `@rpa` spec in a loop, a feature tag',
          'runs that feature (`@rpa` loops, `@test` runs once). `run.bat runner` does the same.',
          '',
        ]
      : [];
    return [
      ...runnerLines,
      '```bat',
      runnerLines.length > 0
        ? 'run.bat                         :: start src\\runner.py (RUNNER_FEATURE from .env)'
        : 'run.bat                         :: run every test, report under outputs\\<date>\\<time>\\',
      'run.bat --collect-only -q       :: list the tests, run nothing',
      'run.bat TAG="(?=.*@test)"       :: only tests whose tags match the regex',
      'run.bat tags                    :: list every tag in this project',
      'run.bat -k login -x             :: extra args go straight to pytest',
      '```',
      '',
      `\`TAG=<regex>\` is passed to pytest as \`${PYWINAUTO_GREP_ENV}\`.`,
      '`set OUTPUT=none` (or `OUTPUT=none` in `.env`) skips the HTML/JUnit report and screenshots.',
      '`run.bat` runs the bundled `task pywin:run-local` / `task pywin:tags` from `Taskfile.yml`,',
      'which call the bundled Python directly.',
      `Tesseract OCR ships under \`${toPosix(TESSERACT_DIR)}/\` with ${TESSERACT_LANGS.join(' + ')} (\`${TESSDATA_ENV}\`).`,
      'pywinauto drives the live UI: run it in an unlocked Windows desktop session.',
    ];
  },
};

const BUNDLE_STRATEGIES: Readonly<Record<string, BundleStrategy>> = {
  k6: k6BundleStrategy,
  playwright: playwrightBundleStrategy,
  'robot-framework': robotBundleStrategy,
  pywinauto: pywinautoBundleStrategy,
};

export function isBundleSupported(tool: string): boolean {
  return Object.hasOwn(BUNDLE_STRATEGIES, tool) && getStandaloneStrategy(tool) !== undefined;
}

function readBundleKey(targetDir: string): BundleKey | null {
  const raw = readJsonObject(path.join(targetDir, BUNDLE_KEY_FILE));
  if (!raw || raw.kind !== BUNDLE_KIND || typeof raw.tool !== 'string') return null;
  return raw as unknown as BundleKey;
}

function buildBundleReadme(
  ctx: BundleContext,
  prepared: BundlePrepared,
  strategy: BundleStrategy,
  runtimes: Readonly<Record<string, string>>,
  envIncluded: boolean,
): string {
  const rows = Object.entries(runtimes).map(([id, version]) => {
    const note = runtimeNote(id);
    return `| ${id} | ${version} | ${note?.license ?? '-'} | ${note?.homepage ?? '-'} |`;
  });
  return [
    `# ${ctx.project} (offline bundle)`,
    '',
    `A zero-install ${ctx.tool} bundle for Windows x64. Extract it anywhere (a path with spaces`,
    'is fine) and run `run.bat`. It needs no installed runtime and no internet: every runtime',
    'it uses ships under `runtime/`, and `run.bat` puts only those on `PATH`.',
    '',
    '## Run',
    '',
    ...strategy.readme(ctx, prepared),
    '',
    '`run.bat TAG=<tag> ...` filters by tag; it must be the first argument. The exit code of the',
    'test run is the exit code of `run.bat`.',
    '',
    '## Environment',
    '',
    envIncluded
      ? 'This bundle INCLUDES the `.env` it was exported with. It may hold secrets: share it with care.'
      : 'No `.env` is included. Copy `.env.template` to `.env` and fill in the values.',
    '',
    '`run.bat` loads `.env` itself: `KEY=value` lines, `#` comment lines, ` #` trailing comments',
    'and double-quoted values. Multi-line values, single quotes and variable interpolation are',
    'not supported.',
    '',
    '## Bundled runtimes',
    '',
    '| Runtime | Version | Licence | Upstream |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    'Each `runtime/<name>/LICENSE-NOTE.txt` repeats the licence and upstream link.',
    '',
    '## Layout',
    '',
    '- `run.bat` — the launcher.',
    '- `runtime/` — the bundled runtimes.',
    '- `automations/`, `src/`, `resources/` — the project and the shared library it uses.',
    `- \`${BUNDLE_KEY_FILE}\` — marks this folder as a bundle export. Exporting into the same`,
    '  folder again updates it in place, replaces `runtime/` and keeps an existing `.env`.',
    '',
  ].join('\n');
}

async function zipBundle(
  exec: Exec,
  targetDir: string,
): Promise<{ zipPath?: string; zipError?: { code: string; message: string } }> {
  const resolved = path.resolve(targetDir);
  const zipPath = `${resolved}.zip`;
  fs.rmSync(zipPath, { force: true });
  const res = await exec(systemTar(), [
    '-a',
    '-c',
    '-f',
    zipPath,
    '--options',
    'zip:compression=store',
    '-C',
    path.dirname(resolved),
    path.basename(resolved),
  ]);
  if (res.ok) return { zipPath };
  return { zipError: { code: 'ZIP_FAILED', message: tailLines(res.output, INSTALL_TAIL_LINES) } };
}

function defaultFetch(url: string): Promise<Response> {
  return fetch(url);
}

export async function exportProjectBundle(
  opts: BundleOptions,
): Promise<BundleError | LifecycleResult<BundleExport>> {
  const { workspaceRoot, tool, type, project, targetDir, onStage } = opts;
  const exec = opts.exec ?? runChild;
  const fetchFn = opts.fetch ?? defaultFetch;
  const log = opts.log ?? (() => {});
  const platform = opts.platform ?? DEFAULT_PLATFORM;

  onStage?.('validate');
  for (const [label, value] of [
    ['tool', tool],
    ['type', type],
    ['project', project],
  ] as const) {
    if (!isSafeIdent(value)) {
      return { code: 'INVALID_IDENT', message: `${label} '${value}' contains unsafe characters` };
    }
  }
  const targetErr = checkTargetPath(targetDir);
  if (targetErr) {
    return {
      code: 'INVALID_TARGET',
      message:
        targetErr === 'NOT_ABSOLUTE'
          ? 'targetDir must be an absolute path'
          : `targetDir must be at most ${MAX_TARGET_PATH} characters`,
    };
  }
  const standalone = getStandaloneStrategy(tool);
  const strategy = Object.hasOwn(BUNDLE_STRATEGIES, tool) ? BUNDLE_STRATEGIES[tool] : undefined;
  if (!standalone || !strategy) {
    return {
      code: 'TOOL_NOT_SUPPORTED',
      message: `Offline bundle export is not yet supported for tool '${tool}'`,
    };
  }
  const sctx: StandaloneContext = { workspaceRoot, tool, type, project };
  const source = standalone.resolveSource(sctx);
  if ('code' in source) return source;

  let mode: 'fresh' | 'migrate' = 'fresh';
  if (isNonEmptyDir(targetDir)) {
    const existing = readBundleKey(targetDir);
    if (!existing) {
      return {
        code: 'TARGET_NOT_EMPTY',
        message: `${targetDir} is not empty and is not a bundle export — empty it or pick another folder`,
      };
    }
    if (existing.tool !== tool) {
      return {
        code: 'TARGET_TOOL_MISMATCH',
        message: `${targetDir} is a bundle export for tool '${existing.tool}', not '${tool}'`,
      };
    }
    mode = 'migrate';
  }

  const ctx: BundleContext = { workspaceRoot, tool, type, project, targetDir, platform, exec, log };
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const written: string[] = [];
    const envTarget = path.join(targetDir, ENV_FILE);

    onStage?.('copy-project');
    const copyEnv = opts.withEnv === true && !fs.existsSync(envTarget);
    written.push(...copyProjectFiles(standalone, source, targetDir, copyEnv));

    onStage?.('copy-resources');
    copyTree(source.resourcesDir, path.join(targetDir, 'resources'));
    written.push('resources');

    onStage?.('rewrite');
    standalone.rewrite(targetDir, sctx);
    strategy.rewrite(ctx);

    onStage?.('generate');
    written.push(...standalone.generateFiles(targetDir, sctx, mode));
    const prepared = strategy.generate(ctx);
    if ('code' in prepared) return prepared;

    onStage?.('embed-key');
    const runtimes: Record<string, string> = {};

    onStage?.('fetch-runtimes');
    fs.rmSync(path.join(targetDir, RUNTIME_DIR), { recursive: true, force: true });
    for (const id of strategy.runtimes) {
      const version = await resolveRuntimeVersion(id, workspaceRoot, exec);
      log(`runtime ${id} ${version}`);
      const err = await vendorRuntime(RUNTIMES[id], {
        workspaceRoot,
        runtimeDir: path.join(targetDir, RUNTIME_DIR, id),
        platform,
        version,
        exec,
        fetch: fetchFn,
      });
      if (err) return err;
      runtimes[id] = version;
    }
    if (strategy.vendor) {
      const vendored = await strategy.vendor(ctx);
      if ('code' in vendored) return vendored;
      Object.assign(runtimes, vendored.runtimes);
    }
    written.push(RUNTIME_DIR);

    onStage?.('install-deps');
    const depsErr = await strategy.installDeps(ctx);
    if (depsErr) return depsErr;

    onStage?.('browsers');
    const browsersErr = await strategy.installBrowsers(ctx);
    if (browsersErr) return browsersErr;

    onStage?.('launcher');
    const envIncluded = fs.existsSync(envTarget);
    fs.writeFileSync(
      path.join(targetDir, LAUNCHER_FILE),
      buildRunBat(strategy.launcher(ctx, prepared)),
      'utf8',
    );
    fs.writeFileSync(
      path.join(targetDir, 'README.md'),
      buildBundleReadme(ctx, prepared, strategy, runtimes, envIncluded),
      'utf8',
    );
    written.push(LAUNCHER_FILE);

    onStage?.('verify-layout');
    const missing = [LAUNCHER_FILE, ...strategy.requiredPaths(ctx, prepared)].filter(
      (rel) => !fs.existsSync(path.join(targetDir, rel)),
    );
    if (missing.length > 0) {
      return {
        code: 'BUNDLE_INCOMPLETE',
        message: `bundle is missing: ${missing.map(toPosix).join(', ')}`,
      };
    }
    const key: BundleKey = {
      sourceProject: project,
      tool,
      type,
      exportedFrom: path.basename(workspaceRoot),
      exportedAt: new Date().toISOString(),
      workspaceVersion: readWorkspaceVersion(workspaceRoot),
      schema: EMBED_SCHEMA,
      kind: BUNDLE_KIND,
      platform,
      runtimes,
      entry: prepared.entry,
    };
    fs.writeFileSync(
      path.join(targetDir, BUNDLE_KEY_FILE),
      `${JSON.stringify(key, null, 2)}\n`,
      'utf8',
    );
    written.push(BUNDLE_KEY_FILE);
    const sizeBytes = dirSize(targetDir);

    onStage?.('zip');
    const zipped = opts.zip === true ? await zipBundle(exec, targetDir) : {};

    const result: BundleExport = {
      tool,
      type,
      project,
      targetDir,
      mode,
      written,
      kind: BUNDLE_KIND,
      platform,
      runtimes,
      entry: prepared.entry,
      sizeBytes,
      envIncluded,
      ...zipped,
    };
    return { result, resynced: false, regeneratedFiles: [] };
  } catch (err) {
    return {
      code: 'EXPORT_FAILED',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
