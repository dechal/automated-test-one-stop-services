import fs from 'node:fs';
import path from 'node:path';
import type { Exec } from './exec.js';

export const K6_VERSION_FALLBACK = '2.0.0';
export const TASK_VERSION_FALLBACK = '3.51.1';
export const NODE_VERSION_FALLBACK = '26.9.0';
export const DOWNLOAD_CACHE_REL = path.join('.cache', 'regenerable', 'bundle-downloads');
export const HOST_PROBE_TIMEOUT_MS = 15_000;

export interface PlatformInfo {
  readonly node: string;
  readonly k6: string;
  readonly task: string;
  readonly python: string;
}

export const PLATFORMS = {
  'win32-x64': {
    node: 'win-x64',
    k6: 'windows-amd64',
    task: 'windows_amd64',
    python: 'windows-x86_64',
  },
} as const satisfies Record<string, PlatformInfo>;

export type PlatformId = keyof typeof PLATFORMS;

export const DEFAULT_PLATFORM: PlatformId = 'win32-x64';

export type RuntimeId = 'node' | 'k6' | 'task';

export interface RuntimeSpec {
  readonly id: RuntimeId;
  readonly license: string;
  readonly homepage: string;
  readonly binRel: string;
  archiveName(version: string, platform: PlatformId): string;
  url(version: string, platform: PlatformId): string;
  innerDir(version: string, platform: PlatformId): string | null;
}

export const RUNTIMES: Readonly<Record<RuntimeId, RuntimeSpec>> = {
  node: {
    id: 'node',
    license: 'MIT',
    homepage: 'https://nodejs.org',
    binRel: 'node.exe',
    archiveName: (v, p) => `node-v${v}-${PLATFORMS[p].node}.zip`,
    url: (v, p) => `https://nodejs.org/dist/v${v}/node-v${v}-${PLATFORMS[p].node}.zip`,
    innerDir: (v, p) => `node-v${v}-${PLATFORMS[p].node}`,
  },
  k6: {
    id: 'k6',
    license: 'AGPL-3.0 (shipped unmodified)',
    homepage: 'https://github.com/grafana/k6',
    binRel: 'k6.exe',
    archiveName: (v, p) => `k6-v${v}-${PLATFORMS[p].k6}.zip`,
    url: (v, p) =>
      `https://github.com/grafana/k6/releases/download/v${v}/k6-v${v}-${PLATFORMS[p].k6}.zip`,
    innerDir: (v, p) => `k6-v${v}-${PLATFORMS[p].k6}`,
  },
  task: {
    id: 'task',
    license: 'MIT',
    homepage: 'https://github.com/go-task/task',
    binRel: 'task.exe',
    archiveName: (_v, p) => `task_${PLATFORMS[p].task}.zip`,
    url: (v, p) =>
      `https://github.com/go-task/task/releases/download/v${v}/task_${PLATFORMS[p].task}.zip`,
    innerDir: () => null,
  },
};

export interface RuntimeNote {
  readonly license: string;
  readonly homepage: string;
}

export const LOCAL_RUNTIME_NOTES = {
  python: { license: 'PSF-2.0', homepage: 'https://www.python.org' },
  tesseract: { license: 'Apache-2.0', homepage: 'https://github.com/tesseract-ocr/tesseract' },
} as const satisfies Record<string, RuntimeNote>;

export function runtimeNote(id: string): RuntimeNote | undefined {
  if (Object.hasOwn(RUNTIMES, id)) return RUNTIMES[id as RuntimeId];
  return Object.hasOwn(LOCAL_RUNTIME_NOTES, id)
    ? LOCAL_RUNTIME_NOTES[id as keyof typeof LOCAL_RUNTIME_NOTES]
    : undefined;
}

export function writeLicenseNote(
  dir: string,
  id: string,
  version: string,
  note: RuntimeNote,
): void {
  fs.writeFileSync(
    path.join(dir, 'LICENSE-NOTE.txt'),
    `${id} ${version}\nLicence: ${note.license}\nUpstream: ${note.homepage}\n`,
    'utf8',
  );
}

export interface RuntimeError {
  readonly code: 'RUNTIME_FETCH_FAILED' | 'RUNTIME_EXTRACT_FAILED';
  readonly message: string;
}

export type FetchFn = (url: string) => Promise<Response>;

const SEMVER = /(\d+\.\d+\.\d+)/;

export function parseK6Version(output: string): string | null {
  return output.match(/\bv(\d+\.\d+\.\d+)/)?.[1] ?? null;
}

export function parseTaskVersion(output: string): string | null {
  return output.match(SEMVER)?.[1] ?? null;
}

export function parseVoltaNode(packageJsonText: string): string | null {
  try {
    const parsed = JSON.parse(packageJsonText) as { volta?: { node?: unknown } };
    const node = parsed.volta?.node;
    return typeof node === 'string' && SEMVER.test(node) ? node : null;
  } catch {
    return null;
  }
}

export function parsePythonVersion(text: string): string | null {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#'));
  return line && /^\d+\.\d+(\.\d+)?$/.test(line) ? line : null;
}

export function readNodeVersion(workspaceRoot: string): string {
  try {
    const text = fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8');
    return parseVoltaNode(text) ?? NODE_VERSION_FALLBACK;
  } catch {
    return NODE_VERSION_FALLBACK;
  }
}

export function readPythonVersion(workspaceRoot: string): string | null {
  try {
    return parsePythonVersion(fs.readFileSync(path.join(workspaceRoot, '.python-version'), 'utf8'));
  } catch {
    return null;
  }
}

async function probeHost(
  exec: Exec,
  cmd: string,
  args: string[],
  parse: (output: string) => string | null,
): Promise<string | null> {
  const res = await exec(cmd, args, {
    shell: process.platform === 'win32',
    timeoutMs: HOST_PROBE_TIMEOUT_MS,
  });
  return res.ok ? parse(res.output) : null;
}

export async function resolveRuntimeVersion(
  id: RuntimeId,
  workspaceRoot: string,
  exec: Exec,
): Promise<string> {
  if (id === 'node') return readNodeVersion(workspaceRoot);
  if (id === 'k6') {
    return (await probeHost(exec, 'k6', ['version'], parseK6Version)) ?? K6_VERSION_FALLBACK;
  }
  return (await probeHost(exec, 'task', ['--version'], parseTaskVersion)) ?? TASK_VERSION_FALLBACK;
}

export function downloadCacheDir(workspaceRoot: string, id: string, version: string): string {
  return path.join(workspaceRoot, DOWNLOAD_CACHE_REL, id, version);
}

export function systemTar(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
}

export async function downloadToCache(
  fetchFn: FetchFn,
  url: string,
  dest: string,
): Promise<RuntimeError | undefined> {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return undefined;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  try {
    const res = await fetchFn(url);
    if (!res.ok) {
      return { code: 'RUNTIME_FETCH_FAILED', message: `${url} returned HTTP ${res.status}` };
    }
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length === 0) {
      return { code: 'RUNTIME_FETCH_FAILED', message: `${url} returned an empty body` };
    }
    fs.writeFileSync(part, body);
    fs.renameSync(part, dest);
    return undefined;
  } catch (err) {
    return {
      code: 'RUNTIME_FETCH_FAILED',
      message: `${url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    fs.rmSync(part, { force: true });
  }
}

export async function extractArchive(
  exec: Exec,
  archive: string,
  destDir: string,
): Promise<RuntimeError | undefined> {
  fs.mkdirSync(destDir, { recursive: true });
  const res = await exec(systemTar(), ['-xf', archive, '-C', destDir]);
  if (res.ok) return undefined;
  return {
    code: 'RUNTIME_EXTRACT_FAILED',
    message: `tar -xf ${archive} failed (exit ${res.code}): ${res.output.trim()}`,
  };
}

export interface VendorRuntimeOptions {
  readonly workspaceRoot: string;
  readonly runtimeDir: string;
  readonly platform: PlatformId;
  readonly version: string;
  readonly exec: Exec;
  readonly fetch: FetchFn;
}

export async function vendorRuntime(
  spec: RuntimeSpec,
  opts: VendorRuntimeOptions,
): Promise<RuntimeError | undefined> {
  const cacheDir = downloadCacheDir(opts.workspaceRoot, spec.id, opts.version);
  const archive = path.join(cacheDir, spec.archiveName(opts.version, opts.platform));
  const fetched = await downloadToCache(opts.fetch, spec.url(opts.version, opts.platform), archive);
  if (fetched) return fetched;
  const extractedRoot = path.join(cacheDir, 'extracted');
  const inner = spec.innerDir(opts.version, opts.platform);
  const sourceDir = inner ? path.join(extractedRoot, inner) : extractedRoot;
  if (!fs.existsSync(path.join(sourceDir, spec.binRel))) {
    fs.rmSync(extractedRoot, { recursive: true, force: true });
    const extracted = await extractArchive(opts.exec, archive, extractedRoot);
    if (extracted) return extracted;
  }
  if (!fs.existsSync(path.join(sourceDir, spec.binRel))) {
    return {
      code: 'RUNTIME_EXTRACT_FAILED',
      message: `${spec.binRel} not found in ${archive} after extraction`,
    };
  }
  fs.rmSync(opts.runtimeDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, opts.runtimeDir, { recursive: true });
  writeLicenseNote(opts.runtimeDir, spec.id, opts.version, spec);
  return undefined;
}

export const PYTHON_INSTALL_REL = path.join(DOWNLOAD_CACHE_REL, 'python');
export const PYTHON_INSTALL_TIMEOUT_MS = 600_000;
const PYTHON_TAIL_LINES = 20;

export interface PythonDir {
  readonly name: string;
  readonly version: string;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function pickCpythonDir(
  names: readonly string[],
  pin: string,
  platform: PlatformId,
): PythonDir | null {
  const pattern = new RegExp(`^cpython-(\\d+\\.\\d+\\.\\d+)-${PLATFORMS[platform].python}-none$`);
  const found = names.flatMap((name) => {
    const version = name.match(pattern)?.[1];
    return version && (version === pin || version.startsWith(`${pin}.`)) ? [{ name, version }] : [];
  });
  found.sort((a, b) => compareVersions(b.version, a.version));
  return found[0] ?? null;
}

export interface VendorPythonOptions {
  readonly workspaceRoot: string;
  readonly runtimeDir: string;
  readonly platform: PlatformId;
  readonly exec: Exec;
}

export async function vendorPython(
  opts: VendorPythonOptions,
): Promise<RuntimeError | { readonly version: string }> {
  const pin = readPythonVersion(opts.workspaceRoot);
  if (!pin) {
    return { code: 'RUNTIME_FETCH_FAILED', message: 'no Python version pin in .python-version' };
  }
  const installDir = path.join(opts.workspaceRoot, PYTHON_INSTALL_REL);
  const res = await opts.exec(
    'uv',
    ['python', 'install', pin, '--install-dir', installDir, '--no-bin', '--no-progress'],
    { timeoutMs: PYTHON_INSTALL_TIMEOUT_MS },
  );
  if (!res.ok) {
    return {
      code: 'RUNTIME_FETCH_FAILED',
      message: `uv python install ${pin} failed (exit ${res.code}): ${res.output.trim().split(/\r?\n/).slice(-PYTHON_TAIL_LINES).join('\n')}`,
    };
  }
  const names = fs.existsSync(installDir) ? fs.readdirSync(installDir) : [];
  const picked = pickCpythonDir(names, pin, opts.platform);
  const sourceDir = picked ? path.join(installDir, picked.name) : null;
  if (!picked || !sourceDir || !fs.existsSync(path.join(sourceDir, 'python.exe'))) {
    return {
      code: 'RUNTIME_EXTRACT_FAILED',
      message: `no cpython-${pin}.x-${PLATFORMS[opts.platform].python}-none/python.exe in ${installDir}`,
    };
  }
  fs.rmSync(opts.runtimeDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, opts.runtimeDir, { recursive: true });
  writeLicenseNote(opts.runtimeDir, 'python', picked.version, LOCAL_RUNTIME_NOTES.python);
  return { version: picked.version };
}

export const TESSERACT_LANGS = ['eng', 'tha'] as const;
export const TESSERACT_OPTIONAL_LANGS = ['osd'] as const;
export const TESSERACT_EXE = 'tesseract.exe';
const TESSDATA_DIR = 'tessdata';
const TESSDATA_CONFIGS = 'configs';
const TESSERACT_HINT =
  'install Tesseract (e.g. `scoop install tesseract`) with the tha language data';

export interface TesseractError {
  readonly code: 'TESSERACT_NOT_FOUND' | 'TESSDATA_MISSING';
  readonly message: string;
}

export function parseShimPath(text: string): string | null {
  const value = text.match(/^\s*path\s*=\s*(.+?)\s*$/m)?.[1];
  if (!value) return null;
  const unquoted = value.replace(/^"(.*)"$/, '$1').trim();
  return unquoted === '' ? null : unquoted;
}

export function parseTesseractVersion(output: string): string | null {
  return output.match(/tesseract\s+v?(\d[\w.]*)/i)?.[1] ?? null;
}

export async function resolveHostTesseract(exec: Exec): Promise<string | null> {
  const res = await exec('where', ['tesseract'], { timeoutMs: HOST_PROBE_TIMEOUT_MS });
  if (!res.ok) return null;
  const first = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (!first) return null;
  const shim = first.replace(/\.exe$/i, '.shim');
  const real = fs.existsSync(shim) ? parseShimPath(fs.readFileSync(shim, 'utf8')) : first;
  return real && fs.existsSync(real) ? real : null;
}

export interface VendorTesseractOptions {
  readonly runtimeDir: string;
  readonly exec: Exec;
}

export async function vendorTesseract(
  opts: VendorTesseractOptions,
): Promise<TesseractError | { readonly version: string }> {
  const exe = await resolveHostTesseract(opts.exec);
  if (!exe) {
    return {
      code: 'TESSERACT_NOT_FOUND',
      message: `tesseract not found on PATH: ${TESSERACT_HINT}`,
    };
  }
  const hostDir = path.dirname(exe);
  const hostData = path.join(hostDir, TESSDATA_DIR);
  const missing = TESSERACT_LANGS.filter(
    (lang) => !fs.existsSync(path.join(hostData, `${lang}.traineddata`)),
  );
  if (missing.length > 0) {
    return {
      code: 'TESSDATA_MISSING',
      message: `${hostData} has no ${missing.map((l) => `${l}.traineddata`).join(', ')}: ${TESSERACT_HINT}`,
    };
  }
  const destData = path.join(opts.runtimeDir, TESSDATA_DIR);
  fs.rmSync(opts.runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(destData, { recursive: true });
  fs.copyFileSync(exe, path.join(opts.runtimeDir, TESSERACT_EXE));
  for (const name of fs.readdirSync(hostDir)) {
    if (/\.dll$/i.test(name))
      fs.copyFileSync(path.join(hostDir, name), path.join(opts.runtimeDir, name));
  }
  for (const lang of [...TESSERACT_LANGS, ...TESSERACT_OPTIONAL_LANGS]) {
    const file = path.join(hostData, `${lang}.traineddata`);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(destData, `${lang}.traineddata`));
  }
  const configs = path.join(hostData, TESSDATA_CONFIGS);
  if (fs.existsSync(configs)) {
    fs.cpSync(configs, path.join(destData, TESSDATA_CONFIGS), {
      recursive: true,
      dereference: true,
    });
  }
  const probe = await opts.exec(exe, ['--version'], { timeoutMs: HOST_PROBE_TIMEOUT_MS });
  const version = parseTesseractVersion(probe.output) ?? 'unknown';
  writeLicenseNote(opts.runtimeDir, 'tesseract', version, LOCAL_RUNTIME_NOTES.tesseract);
  return { version };
}
