import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUNDLE_KEY_FILE,
  BUNDLE_STAGES,
  type BundleOptions,
  type BundleStage,
  browserDirName,
  buildPywin32Sitecustomize,
  exportProjectBundle,
  findK6Entry,
  isBundleSupported,
  PLAYWRIGHT_BROWSERS_CACHE_REL,
  readBrowserRevisions,
  readPyprojectName,
  rewriteDayjsImports,
  rewriteToolResourcePaths,
  toBundledTaskfile,
} from '../bundle.js';
import type { Exec, RunChildResult } from '../exec.js';

const ok = (output = ''): RunChildResult => ({
  ok: true,
  code: 0,
  stdout: output,
  stderr: '',
  output,
});

interface FakeExec {
  readonly exec: Exec;
  readonly calls: { cmd: string; args: string[] }[];
}

function fakeExec(pnpmFails = false): FakeExec {
  const calls: { cmd: string; args: string[] }[] = [];
  const exec: Exec = async (cmd, args, options) => {
    calls.push({ cmd, args });
    if (cmd === 'k6') return ok('k6.exe v2.0.0 (commit/x, go1.26.3, windows/amd64)');
    if (cmd.endsWith('tar.exe') && args[0] === '-xf') {
      const inner = path.join(args[args.indexOf('-C') + 1] ?? '', 'k6-v2.0.0-windows-amd64');
      fs.mkdirSync(inner, { recursive: true });
      fs.writeFileSync(path.join(inner, 'k6.exe'), 'exe');
      return ok();
    }
    if (cmd.endsWith('tar.exe')) {
      fs.writeFileSync(args[args.indexOf('-f') + 1] ?? '', 'zip');
      return ok();
    }
    if (cmd === 'pnpm') {
      if (pnpmFails)
        return { ok: false, code: 1, stdout: '', stderr: 'boom', output: 'line\nboom' };
      const dayjs = path.join(options?.cwd ?? '', 'node_modules', 'dayjs');
      fs.mkdirSync(dayjs, { recursive: true });
      fs.writeFileSync(path.join(dayjs, 'package.json'), '{}');
      fs.writeFileSync(path.join(dayjs, 'dayjs.min.js'), '');
      return ok();
    }
    return { ok: false, code: 1, stdout: '', stderr: 'unexpected', output: 'unexpected' };
  };
  return { exec, calls };
}

const fetchZip = async (): Promise<Response> => new Response(new Uint8Array([1, 2, 3]));

let root: string;
let projectDir: string;

function write(rel: string, text: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-bundle-'));
  write('package.json', '{"version":"1.2.3","volta":{"node":"26.9.0"}}');
  write(
    'tools/k6/package.json',
    '{"packageManager":"pnpm@11.23.0","dependencies":{"dayjs":"^1.11.23"}}',
  );
  write(
    'tools/k6/resources/src/utils/file-management.ts',
    `const base = \`projects/performance/\${projectName}\`;\n`,
  );
  write(
    'tools/k6/resources/src/utils/date-time-management.ts',
    "import dayjs from 'dayjs';\nimport utc from 'dayjs/plugin/utc.js';\ndayjs.extend(utc);\n",
  );
  projectDir = path.join(root, 'tools', 'k6', 'projects', 'performance', 'demo');
  write('tools/k6/projects/performance/demo/automations/specs/soap/e2e.spec.ts', 'export {};\n');
  write('tools/k6/projects/performance/demo/automations/specs/rest/e2e.spec.ts', 'export {};\n');
  write('tools/k6/projects/performance/demo/src/configs/env-variable.ts', 'export {};\n');
  write('tools/k6/projects/performance/demo/.env.template', 'BASE_URL=""\n');
  write('tools/k6/projects/performance/demo/.env', 'BASE_URL="https://secret"\n');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function options(targetDir: string, extra: Partial<BundleOptions> = {}): BundleOptions {
  return {
    workspaceRoot: root,
    tool: 'k6',
    type: 'performance',
    project: 'demo',
    targetDir,
    exec: fakeExec().exec,
    fetch: fetchZip,
    ...extra,
  };
}

describe('isBundleSupported', () => {
  it('supports every tool with a standalone strategy', () => {
    expect(isBundleSupported('k6')).toBe(true);
    expect(isBundleSupported('playwright')).toBe(true);
    expect(isBundleSupported('robot-framework')).toBe(true);
    expect(isBundleSupported('pywinauto')).toBe(true);
    expect(isBundleSupported('constructor')).toBe(false);
  });
});

describe('rewriteDayjsImports', () => {
  it('points bare dayjs imports at the bundled UMD files, relative to each file', () => {
    const target = path.join(root, 'b');
    const src = 'import dayjs from \'dayjs\';\nimport tz from "dayjs/plugin/timezone.js";\n';
    const out = rewriteDayjsImports(src, path.join(target, 'resources', 'src', 'utils'), target);
    expect(out).toBe(
      "import dayjs from '../../../node_modules/dayjs/dayjs.min.js';\n" +
        'import tz from "../../../node_modules/dayjs/plugin/timezone.js";\n',
    );
  });

  it('leaves other imports alone', () => {
    const src = "import x from 'dayjsx';\nimport y from './dayjs.ts';\n";
    expect(rewriteDayjsImports(src, root, root)).toBe(src);
  });
});

describe('findK6Entry', () => {
  it('returns the first e2e.spec.ts in sorted order', () => {
    expect(findK6Entry(projectDir)).toBe('automations/specs/rest/e2e.spec.ts');
  });
});

describe('exportProjectBundle (k6)', () => {
  it('builds a fresh bundle without .env by default', async () => {
    const target = path.join(root, 'out', 'k6 bundle');
    const fake = fakeExec();
    const stages: BundleStage[] = [];
    const res = await exportProjectBundle(
      options(target, { exec: fake.exec, onStage: (s) => stages.push(s) }),
    );
    if ('code' in res) throw new Error(`${res.code}: ${res.message}`);
    expect(stages).toEqual([...BUNDLE_STAGES]);
    expect(res.result).toMatchObject({
      mode: 'fresh',
      kind: 'bundle',
      runtimes: { k6: '2.0.0' },
      entry: 'automations/specs/rest/e2e.spec.ts',
      envIncluded: false,
    });
    expect(res.result.sizeBytes).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(target, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(target, '.env.template'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.standalone.json'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'runtime', 'k6', 'k6.exe'))).toBe(true);
    const key = JSON.parse(fs.readFileSync(path.join(target, BUNDLE_KEY_FILE), 'utf8'));
    expect(key).toMatchObject({ kind: 'bundle', tool: 'k6', platform: 'win32-x64' });
    const bat = fs.readFileSync(path.join(target, 'run.bat'), 'utf8');
    expect(bat).toContain('set "PATH=%B%\\runtime\\k6;%SystemRoot%\\System32;%SystemRoot%"');
    expect(bat).toContain('-e "SUMMARY_DIR=outputs/k6/demo"');
    expect(bat).toContain('set "ENTRY=automations/specs/rest/e2e.spec.ts"');
    const dt = fs.readFileSync(
      path.join(target, 'resources', 'src', 'utils', 'date-time-management.ts'),
      'utf8',
    );
    expect(dt).toContain("from '../../../node_modules/dayjs/dayjs.min.js'");
    expect(dt).toContain("from '../../../node_modules/dayjs/plugin/utc.js'");
    const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    expect(pkg.dependencies).toEqual({ dayjs: '^1.11.23' });
    const pnpm = fake.calls.find((c) => c.cmd === 'pnpm');
    expect(pnpm?.args).toEqual(
      expect.arrayContaining([
        'install',
        '--ignore-workspace',
        '--prod',
        '--config.node-linker=hoisted',
      ]),
    );
    expect(fs.readFileSync(path.join(target, 'README.md'), 'utf8')).toContain('offline bundle');
  });

  it('adds the CI container and both pipelines with ci both', async () => {
    const target = path.join(root, 'ci-both');
    const res = await exportProjectBundle(options(target, { ci: 'both' }));
    if ('code' in res) throw new Error(`${res.code}: ${res.message}`);
    expect(res.result.ciFiles).toEqual([
      'Dockerfile',
      '.dockerignore',
      '.gitlab-ci.yml',
      '.github/workflows/test.yml',
    ]);
    expect(res.result.written).not.toContain('.github/workflows/ci.yml');
    expect(fs.existsSync(path.join(target, '.github', 'workflows', 'ci.yml'))).toBe(false);
    const readme = fs.readFileSync(path.join(target, 'README.md'), 'utf8');
    expect(readme).toContain('offline bundle');
    expect(readme).toContain('## CI/CD');
    expect(fs.readFileSync(path.join(target, '.gitlab-ci.yml'), 'utf8')).toContain('-e BASE_URL');
  });
  it('keeps the default output without ci', async () => {
    const target = path.join(root, 'ci-none');
    const res = await exportProjectBundle(options(target));
    if ('code' in res) throw new Error(`${res.code}: ${res.message}`);
    expect(res.result.ciFiles).toBeUndefined();
    expect(fs.existsSync(path.join(target, '.gitlab-ci.yml'))).toBe(false);
    expect(fs.existsSync(path.join(target, '.github', 'workflows', 'ci.yml'))).toBe(true);
  });
  it('copies .env only with withEnv', async () => {
    const target = path.join(root, 'with-env');
    const res = await exportProjectBundle(options(target, { withEnv: true }));
    if ('code' in res) throw new Error(res.code);
    expect(res.result.envIncluded).toBe(true);
    expect(fs.readFileSync(path.join(target, '.env'), 'utf8')).toContain('secret');
  });

  it('migrates an existing bundle, keeps its .env and replaces runtime/', async () => {
    const target = path.join(root, 'migrate');
    expect('code' in (await exportProjectBundle(options(target)))).toBe(false);
    fs.writeFileSync(path.join(target, '.env'), 'MINE=1\n');
    fs.writeFileSync(path.join(target, 'runtime', 'stale.txt'), 'old');
    const res = await exportProjectBundle(options(target, { withEnv: true }));
    if ('code' in res) throw new Error(res.code);
    expect(res.result.mode).toBe('migrate');
    expect(fs.readFileSync(path.join(target, '.env'), 'utf8')).toBe('MINE=1\n');
    expect(fs.existsSync(path.join(target, 'runtime', 'stale.txt'))).toBe(false);
  });

  it('refuses a foreign folder, a standalone export and another tool bundle', async () => {
    const foreign = path.join(root, 'foreign');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'x.txt'), 'x');
    expect(await exportProjectBundle(options(foreign))).toMatchObject({ code: 'TARGET_NOT_EMPTY' });

    const standalone = path.join(root, 'standalone');
    fs.mkdirSync(standalone);
    fs.writeFileSync(path.join(standalone, '.standalone.json'), '{"tool":"k6"}');
    expect(await exportProjectBundle(options(standalone))).toMatchObject({
      code: 'TARGET_NOT_EMPTY',
    });

    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, BUNDLE_KEY_FILE), '{"kind":"bundle","tool":"playwright"}');
    expect(await exportProjectBundle(options(other))).toMatchObject({
      code: 'TARGET_TOOL_MISMATCH',
    });
  });

  it('validates identifiers, target, tool and source before writing', async () => {
    const target = path.join(root, 'never');
    expect(await exportProjectBundle({ ...options(target), project: '../x' })).toMatchObject({
      code: 'INVALID_IDENT',
    });
    expect(await exportProjectBundle(options('relative/out'))).toMatchObject({
      code: 'INVALID_TARGET',
    });
    expect(await exportProjectBundle({ ...options(target), tool: 'appium' })).toMatchObject({
      code: 'TOOL_NOT_SUPPORTED',
    });
    expect(await exportProjectBundle({ ...options(target), project: 'missing' })).toMatchObject({
      code: 'SOURCE_MISSING',
    });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('fails with DEPS_INSTALL_FAILED and never writes the bundle key', async () => {
    const target = path.join(root, 'deps-fail');
    const res = await exportProjectBundle(options(target, { exec: fakeExec(true).exec }));
    expect(res).toMatchObject({ code: 'DEPS_INSTALL_FAILED', message: 'line\nboom' });
    expect(fs.existsSync(path.join(target, BUNDLE_KEY_FILE))).toBe(false);
  });

  it('creates a zip next to the folder on request', async () => {
    const target = path.join(root, 'zipped');
    const res = await exportProjectBundle(options(target, { zip: true }));
    if ('code' in res) throw new Error(res.code);
    expect(res.result.zipPath).toBe(`${target}.zip`);
    expect(fs.existsSync(`${target}.zip`)).toBe(true);
  });
});

const PW_BROWSERS_JSON = JSON.stringify({
  browsers: [
    { name: 'chromium', revision: '1243' },
    { name: 'chromium-headless-shell', revision: '1243' },
    { name: 'ffmpeg', revision: '1011' },
    { name: 'winldd', revision: '1007' },
    { name: 'firefox' },
  ],
});
const PW_CACHE_DIRS = [
  'chromium-1243',
  'chromium_headless_shell-1243',
  'ffmpeg-1011',
  'winldd-1007',
];

function fakePlaywrightExec(): FakeExec {
  const calls: { cmd: string; args: string[] }[] = [];
  const exec: Exec = async (cmd, args, options) => {
    calls.push({ cmd, args });
    if (cmd.endsWith('tar.exe') && args[0] === '-xf') {
      const inner = path.join(args[args.indexOf('-C') + 1] ?? '', 'node-v26.9.0-win-x64');
      fs.mkdirSync(inner, { recursive: true });
      fs.writeFileSync(path.join(inner, 'node.exe'), 'exe');
      return ok();
    }
    if (cmd === 'pnpm') {
      const nm = path.join(options?.cwd ?? '', 'node_modules');
      fs.mkdirSync(path.join(nm, '@playwright', 'test'), { recursive: true });
      fs.writeFileSync(path.join(nm, '@playwright', 'test', 'cli.js'), '');
      fs.mkdirSync(path.join(nm, 'playwright-core'), { recursive: true });
      fs.writeFileSync(path.join(nm, 'playwright-core', 'browsers.json'), PW_BROWSERS_JSON);
      return ok();
    }
    if (cmd.endsWith('node.exe') && args.includes('install')) {
      const dest = options?.env?.PLAYWRIGHT_BROWSERS_PATH ?? '';
      for (const d of ['chromium-1243', 'chromium_headless_shell-1243']) {
        fs.mkdirSync(path.join(dest, d), { recursive: true });
      }
      return ok();
    }
    return { ok: false, code: 1, stdout: '', stderr: 'unexpected', output: 'unexpected' };
  };
  return { exec, calls };
}

function writePlaywrightFixture(): void {
  write('tools/playwright/package.json', '{"devDependencies":{"@playwright/test":"1.63.0"}}');
  write(
    'tools/playwright/resources/src/utils/playwright-global-config.ts',
    "export const c = { tsconfig: '../../tsconfig.json' };\n",
  );
  write(
    'tools/playwright/resources/src/utils/file-management.ts',
    'export function getOutputDirectory(baseDir: string): string {\n  return baseDir;\n}\n',
  );
  write('tools/playwright/projects/web/demo/playwright.config.ts', 'export default {};\n');
  write('tools/playwright/projects/web/demo/automations/specs/a.spec.ts', 'export {};\n');
  write('tools/playwright/projects/web/demo/.env.template', 'BASE_URL=""\n');
}

function playwrightOptions(targetDir: string, exec: Exec): BundleOptions {
  return {
    workspaceRoot: root,
    tool: 'playwright',
    type: 'web',
    project: 'demo',
    targetDir,
    exec,
    fetch: fetchZip,
  };
}

describe('readBrowserRevisions', () => {
  it('maps browser names to revisions and skips entries without one', () => {
    expect(readBrowserRevisions(PW_BROWSERS_JSON)).toEqual({
      chromium: '1243',
      'chromium-headless-shell': '1243',
      ffmpeg: '1011',
      winldd: '1007',
    });
    expect(readBrowserRevisions('not json')).toEqual({});
    expect(readBrowserRevisions('{"browsers":3}')).toEqual({});
  });

  it('builds the on-disk browser folder name', () => {
    expect(browserDirName('chromium-headless-shell', '1243')).toBe('chromium_headless_shell-1243');
    expect(browserDirName('chromium', '1243')).toBe('chromium-1243');
  });
});

describe('exportProjectBundle (playwright)', () => {
  beforeEach(writePlaywrightFixture);

  it('vendors node, installs all deps hoisted and copies matching browsers from the cache', async () => {
    for (const d of PW_CACHE_DIRS) write(path.join(PLAYWRIGHT_BROWSERS_CACHE_REL, d, 'MARK'), d);
    const target = path.join(root, 'out', 'pw bundle');
    const fake = fakePlaywrightExec();
    const res = await exportProjectBundle(playwrightOptions(target, fake.exec));
    if ('code' in res) throw new Error(`${res.code}: ${res.message}`);
    expect(res.result).toMatchObject({ runtimes: { node: '26.9.0' }, entry: null });
    for (const d of PW_CACHE_DIRS) {
      expect(fs.existsSync(path.join(target, 'runtime', 'browsers', d, 'MARK'))).toBe(true);
    }
    expect(fs.existsSync(path.join(target, 'runtime', 'node', 'node.exe'))).toBe(true);
    const pnpm = fake.calls.find((c) => c.cmd === 'pnpm');
    expect(pnpm?.args).toEqual(
      expect.arrayContaining([
        'install',
        '--ignore-workspace',
        '--config.node-linker=hoisted',
        '--frozen-lockfile=false',
      ]),
    );
    expect(pnpm?.args).not.toContain('--prod');
    expect(fake.calls.some((c) => c.cmd.endsWith('node.exe'))).toBe(false);
    const bat = fs.readFileSync(path.join(target, 'run.bat'), 'utf8');
    expect(bat).toContain('set "PATH=%B%\\runtime\\node;%SystemRoot%\\System32;%SystemRoot%"');
    expect(bat).toContain('set "PLAYWRIGHT_BROWSERS_PATH=%B%\\runtime\\browsers"');
    expect(bat).toContain('if defined TAG set "PLAYWRIGHT_GREP=!TAG!"');
    expect(bat).toContain(
      '"!B!\\runtime\\node\\node.exe" "!B!\\node_modules\\@playwright\\test\\cli.js" test !REST!',
    );
  });

  it('falls back to the bundled playwright install when the cache revs do not match', async () => {
    write(path.join(PLAYWRIGHT_BROWSERS_CACHE_REL, 'chromium-1217', 'MARK'), 'old');
    const target = path.join(root, 'pw-install');
    const fake = fakePlaywrightExec();
    const res = await exportProjectBundle(playwrightOptions(target, fake.exec));
    if ('code' in res) throw new Error(`${res.code}: ${res.message}`);
    const install = fake.calls.find((c) => c.cmd.endsWith('node.exe'));
    expect(install?.args.slice(-2)).toEqual(['install', 'chromium']);
    expect(fs.existsSync(path.join(target, 'runtime', 'browsers', 'chromium-1243'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'runtime', 'browsers', 'chromium-1217'))).toBe(false);
  });

  it('fails with BROWSERS_FAILED when no chromium folder ends up in runtime/browsers', async () => {
    const target = path.join(root, 'pw-fail');
    const fake = fakePlaywrightExec();
    const exec: Exec = (cmd, args, options) =>
      cmd.endsWith('node.exe') ? Promise.resolve(ok()) : fake.exec(cmd, args, options);
    const res = await exportProjectBundle(playwrightOptions(target, exec));
    expect(res).toMatchObject({ code: 'BROWSERS_FAILED' });
    expect(fs.existsSync(path.join(target, BUNDLE_KEY_FILE))).toBe(false);
  });
});

const CPYTHON_DIR = 'cpython-3.14.4-windows-x86_64-none';
const SITE = path.join('runtime', 'python', 'Lib', 'site-packages');
const BATTERIES_BROWSERS_JSON = path.join(
  'BrowserBatteries',
  'bin',
  'wrapper',
  'node_modules',
  'playwright-core',
  'browsers.json',
);

interface FakePythonOptions {
  readonly sitePackages: readonly string[];
  readonly browserInstallWorks?: boolean;
}

function fakePythonExec(opts: FakePythonOptions): FakeExec {
  const calls: { cmd: string; args: string[] }[] = [];
  const exec: Exec = async (cmd, args, options) => {
    calls.push({ cmd, args });
    if (cmd === 'uv' && args[0] === 'python') {
      const dir = path.join(args[args.indexOf('--install-dir') + 1] ?? '', CPYTHON_DIR);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'python.exe'), 'py');
      return ok();
    }
    if (cmd === 'uv' && args[0] === 'export') {
      fs.writeFileSync(args[args.indexOf('-o') + 1] ?? '', 'pywin32==311\n');
      return ok();
    }
    if (cmd === 'uv' && args[0] === 'pip') {
      const site = path.join(
        path.dirname(args[args.indexOf('--python') + 1] ?? ''),
        'Lib',
        'site-packages',
      );
      for (const rel of opts.sitePackages) {
        fs.mkdirSync(path.dirname(path.join(site, rel)), { recursive: true });
        fs.writeFileSync(path.join(site, rel), rel.endsWith('.json') ? PW_BROWSERS_JSON : '');
      }
      return ok();
    }
    if (cmd.endsWith('python.exe') && args.includes('Browser.entry')) {
      if (opts.browserInstallWorks) {
        const dest = options?.env?.PLAYWRIGHT_BROWSERS_PATH ?? '';
        fs.mkdirSync(path.join(dest, 'chromium-1243'), { recursive: true });
      }
      return ok();
    }
    if (cmd.endsWith('python.exe') && args[0] === '-c') {
      const site = path.join(path.dirname(cmd), 'Lib', 'site-packages');
      fs.mkdirSync(path.join(site, 'comtypes', 'gen'), { recursive: true });
      return ok();
    }
    if (cmd === 'task') return ok('3.51.1');
    if (cmd.endsWith('tar.exe') && args[0] === '-xf') {
      const dest = args[args.indexOf('-C') + 1] ?? '';
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'task.exe'), 'exe');
      return ok();
    }
    if (cmd === 'where') return ok(`${path.join(root, 'host', 'tesseract', 'tesseract.exe')}\r\n`);
    if (cmd.endsWith('tesseract.exe')) return ok('tesseract v5.5.0.20241111\n');
    return { ok: false, code: 1, stdout: '', stderr: 'unexpected', output: 'unexpected' };
  };
  return { exec, calls };
}

function pythonOptions(tool: string, type: string, targetDir: string, exec: Exec): BundleOptions {
  return { workspaceRoot: root, tool, type, project: 'demo', targetDir, exec, fetch: fetchZip };
}

describe('readPyprojectName', () => {
  it('reads [project].name and ignores other tables', () => {
    const text = '[tool.uv]\nname = "nope"\n[project]\nversion = "1"\nname = "robot-pkg"\n';
    expect(readPyprojectName(text)).toBe('robot-pkg');
    expect(readPyprojectName('[tool.x]\nname = "x"\n')).toBeNull();
  });
});

describe('rewriteToolResourcePaths', () => {
  it('re-points paths that reach the tool resources dir at the bundle resources dir', () => {
    const src =
      'Variables  ../../../../../resources/src/python-libs/T.py\n' +
      'Resource   ../../base.resource\n' +
      'Resource   ../../../resources/kept.resource\n';
    const out = rewriteToolResourcePaths(src, 'automations/modules', 'projects/web/demo');
    expect(out).toBe(
      'Variables  ../../resources/src/python-libs/T.py\n' +
        'Resource   ../../base.resource\n' +
        'Resource   ../../../resources/kept.resource\n',
    );
    expect(rewriteToolResourcePaths('../../../resources/a', '', 'projects/web/demo')).toBe(
      'resources/a',
    );
  });
});

describe('exportProjectBundle (robot-framework)', () => {
  beforeEach(() => {
    write('.python-version', '3.14\n');
    write('tools/robot-framework/pyproject.toml', '[project]\nname = "robot-pkg"\n');
    write('tools/robot-framework/resources/src/python-libs/T.py', 'X = 1\n');
    for (const type of ['web', 'desktop']) {
      write(
        `tools/robot-framework/projects/${type}/demo/automations/specs/a.robot`,
        '*** Test Cases ***\n',
      );
      write(
        `tools/robot-framework/projects/${type}/demo/automations/modules/base.resource`,
        '*** Settings ***\nVariables    ../../../../../resources/src/python-libs/T.py\n',
      );
      write(`tools/robot-framework/projects/${type}/demo/.env.template`, 'BASE_URL=""\n');
    }
  });

  it('desktop: vendors python, installs the locked package deps and skips browsers', async () => {
    const target = path.join(root, 'out', 'robot desktop');
    const fake = fakePythonExec({ sitePackages: [path.join('robot', '__init__.py')] });
    const res = await exportProjectBundle(
      pythonOptions('robot-framework', 'desktop', target, fake.exec),
    );
    if ('code' in res) throw new Error(`${res.code}: ${res.message}`);
    expect(res.result).toMatchObject({
      runtimes: { python: '3.14.4' },
      entry: 'automations/specs',
    });
    const uvExport = fake.calls.find((c) => c.cmd === 'uv' && c.args[0] === 'export');
    expect(uvExport?.args).toEqual(
      expect.arrayContaining([
        '--frozen',
        '--package',
        'robot-pkg',
        '--no-emit-workspace',
        '--no-dev',
      ]),
    );
    const pip = fake.calls.find((c) => c.cmd === 'uv' && c.args[0] === 'pip');
    expect(pip?.args).toEqual(
      expect.arrayContaining([
        path.join(target, 'runtime', 'python', 'python.exe'),
        '--system',
        '--break-system-packages',
      ]),
    );
    expect(fake.calls.some((c) => c.args.includes('Browser.entry'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'runtime', 'browsers'))).toBe(false);
    const bat = fs.readFileSync(path.join(target, 'run.bat'), 'utf8');
    expect(bat).toContain('set "PATH=%B%\\runtime\\python;%SystemRoot%\\System32;%SystemRoot%"');
    expect(bat).not.toContain('PLAYWRIGHT_BROWSERS_PATH=%B%');
    expect(bat).toContain('if defined TAG set TAGARGS=--include "!TAG!"');
    expect(bat).toContain('set "ENTRY=automations/specs"');
    expect(bat).toContain(
      '"!B!\\runtime\\python\\python.exe" -m robot !TAGARGS! -d outputs !REST! "!ENTRY!"',
    );
    expect(
      fs.readFileSync(path.join(target, 'automations', 'modules', 'base.resource'), 'utf8'),
    ).toContain('Variables    ../../resources/src/python-libs/T.py');
  });

  it('web: Browser.entry install fills runtime/browsers', async () => {
    const target = path.join(root, 'robot-web');
    const fake = fakePythonExec({
      sitePackages: [
        path.join('robot', '__init__.py'),
        path.join('Browser', '__init__.py'),
        BATTERIES_BROWSERS_JSON,
      ],
      browserInstallWorks: true,
    });
    const res = await exportProjectBundle(
      pythonOptions('robot-framework', 'web', target, fake.exec),
    );
    if ('code' in res) throw new Error(`${res.code}: ${res.message}`);
    const install = fake.calls.find((c) => c.args.includes('Browser.entry'));
    expect(install?.args).toEqual(['-m', 'Browser.entry', 'install', 'chromium']);
    expect(fs.existsSync(path.join(target, 'runtime', 'browsers', 'chromium-1243'))).toBe(true);
    const bat = fs.readFileSync(path.join(target, 'run.bat'), 'utf8');
    expect(bat).toContain('set "PLAYWRIGHT_BROWSERS_PATH=%B%\\runtime\\browsers"');
  });

  it('web: falls back to the cache copy by wrapper revision, else BROWSERS_FAILED', async () => {
    const sitePackages = [
      path.join('robot', '__init__.py'),
      path.join('Browser', '__init__.py'),
      BATTERIES_BROWSERS_JSON,
    ];
    const failed = await exportProjectBundle(
      pythonOptions(
        'robot-framework',
        'web',
        path.join(root, 'rw-fail'),
        fakePythonExec({ sitePackages }).exec,
      ),
    );
    expect(failed).toMatchObject({ code: 'BROWSERS_FAILED' });
    expect(fs.existsSync(path.join(root, 'rw-fail', BUNDLE_KEY_FILE))).toBe(false);

    for (const d of PW_CACHE_DIRS) write(path.join(PLAYWRIGHT_BROWSERS_CACHE_REL, d, 'MARK'), d);
    const target = path.join(root, 'rw-copy');
    const res = await exportProjectBundle(
      pythonOptions('robot-framework', 'web', target, fakePythonExec({ sitePackages }).exec),
    );
    if ('code' in res) throw new Error(`${res.code}: ${res.message}`);
    for (const d of PW_CACHE_DIRS) {
      expect(fs.existsSync(path.join(target, 'runtime', 'browsers', d, 'MARK'))).toBe(true);
    }
  });
});

describe('pywinauto bundle helpers', () => {
  it('generates a comment-free sitecustomize that adds the pywin32 DLL dir', () => {
    const text = buildPywin32Sitecustomize();
    expect(text).toContain("os.path.join(sys.prefix, 'Lib', 'site-packages', 'pywin32_system32')");
    expect(text).toContain('os.add_dll_directory(PYWIN32_DLL_DIR)');
    expect(text).not.toContain('#');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('rewrites uv run pytest to the bundled python and clears PYTHONHOME in every block', () => {
    const src = [
      'tasks:',
      '  a:',
      '    cmds:',
      '      - |',
      '        X=1 uv run pytest {{.CLI_ARGS}}',
      '  b:',
      '    cmds:',
      '      - uv run pytest --collect-only',
      '',
    ].join('\n');
    expect(toBundledTaskfile(src)).toBe(
      [
        'tasks:',
        '  a:',
        '    cmds:',
        '      - |',
        '        unset PYTHONHOME PYTHONPATH',
        '        X=1 "{{.TASKFILE_DIR}}/runtime/python/python.exe" -m pytest {{.CLI_ARGS}}',
        '  b:',
        '    cmds:',
        '      - |',
        '        unset PYTHONHOME PYTHONPATH',
        '        "{{.TASKFILE_DIR}}/runtime/python/python.exe" -m pytest --collect-only',
        '',
      ].join('\n'),
    );
  });
});

describe('exportProjectBundle (pywinauto)', () => {
  beforeEach(() => {
    write('.python-version', '3.14\n');
    write('tools/pywinauto/pyproject.toml', '[project]\nname = "pywin-pkg"\ndependencies = []\n');
    write('tools/pywinauto/resources/global_resources/__init__.py', '');
    write(
      'tools/pywinauto/projects/desktop/demo/pytest.ini',
      '[pytest]\npythonpath = . ../../../resources\n',
    );
    write('tools/pywinauto/projects/desktop/demo/conftest.py', '');
    write('tools/pywinauto/projects/desktop/demo/automations/specs/test_positive.py', '');
    write('host/tesseract/tesseract.exe', 'exe');
    write('host/tesseract/libtesseract-5.dll', 'dll');
    write('host/tesseract/tessdata/eng.traineddata', 'eng');
    write('host/tesseract/tessdata/tha.traineddata', 'tha');
  });

  const sitePackages = [path.join('pywinauto', '__init__.py'), path.join('pytest', '__init__.py')];

  it('vendors python, task and tesseract, writes sitecustomize, comtypes.gen and the launcher', async () => {
    const target = path.join(root, 'out', 'pywin bundle');
    const fake = fakePythonExec({ sitePackages });
    const res = await exportProjectBundle(pythonOptions('pywinauto', 'desktop', target, fake.exec));
    if ('code' in res) throw new Error(`${res.code}: ${res.message}`);
    expect(res.result.runtimes).toEqual({
      task: '3.51.1',
      python: '3.14.4',
      tesseract: '5.5.0.20241111',
    });
    const uvExport = fake.calls.find((c) => c.cmd === 'uv' && c.args[0] === 'export');
    expect(uvExport?.args).toEqual(expect.arrayContaining(['--package', 'pywin-pkg']));
    expect(fs.readFileSync(path.join(target, SITE, 'sitecustomize.py'), 'utf8')).toBe(
      buildPywin32Sitecustomize(),
    );
    expect(fs.existsSync(path.join(target, SITE, 'comtypes', 'gen'))).toBe(true);
    for (const rel of [
      'task/task.exe',
      'tesseract/tesseract.exe',
      'tesseract/tessdata/tha.traineddata',
    ]) {
      expect(fs.existsSync(path.join(target, 'runtime', rel))).toBe(true);
    }
    const taskfile = fs.readFileSync(path.join(target, 'Taskfile.yml'), 'utf8');
    expect(taskfile).not.toContain('uv run');
    expect(taskfile).toContain('"{{.TASKFILE_DIR}}/runtime/python/python.exe" -m pytest');
    const bat = fs.readFileSync(path.join(target, 'run.bat'), 'utf8');
    expect(bat).toContain(
      'set "PATH=%B%\\runtime\\python;%B%\\runtime\\task;%B%\\runtime\\tesseract;%SystemRoot%\\System32;%SystemRoot%"',
    );
    expect(bat).toContain('set "TESSDATA_PREFIX=%B%\\runtime\\tesseract\\tessdata"');
    expect(bat).toContain('if defined TAG set "PYWINAUTO_GREP=!TAG!"');
    expect(bat).toContain('if /i "%~1"=="tags" goto :sub_tags');
    expect(bat).toContain('"!B!\\runtime\\task\\task.exe" pywin:run-local -- !REST!');
    expect(bat).toContain('"!B!\\runtime\\task\\task.exe" pywin:tags');
  });

  it('fails with TESSDATA_MISSING when the host has no tha data', async () => {
    fs.rmSync(path.join(root, 'host', 'tesseract', 'tessdata', 'tha.traineddata'));
    const target = path.join(root, 'pywin-no-tha');
    const res = await exportProjectBundle(
      pythonOptions('pywinauto', 'desktop', target, fakePythonExec({ sitePackages }).exec),
    );
    expect(res).toMatchObject({ code: 'TESSDATA_MISSING' });
    expect(fs.existsSync(path.join(target, BUNDLE_KEY_FILE))).toBe(false);
  });
});
