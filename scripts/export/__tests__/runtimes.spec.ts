import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Exec, RunChildResult } from '../exec.js';
import {
  downloadCacheDir,
  downloadToCache,
  K6_VERSION_FALLBACK,
  PYTHON_INSTALL_REL,
  parseK6Version,
  parsePythonVersion,
  parseShimPath,
  parseTaskVersion,
  parseTesseractVersion,
  parseVoltaNode,
  pickCpythonDir,
  RUNTIMES,
  readNodeVersion,
  resolveHostTesseract,
  resolveRuntimeVersion,
  runtimeNote,
  TASK_VERSION_FALLBACK,
  vendorPython,
  vendorRuntime,
  vendorTesseract,
} from '../runtimes.js';

const ok = (output: string): RunChildResult => ({
  ok: true,
  code: 0,
  stdout: output,
  stderr: '',
  output,
});
const fail: RunChildResult = { ok: false, code: 1, stdout: '', stderr: 'x', output: 'x' };

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-runtimes-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('URL builders', () => {
  it('builds the k6 release URL', () => {
    expect(RUNTIMES.k6.url('2.0.0', 'win32-x64')).toBe(
      'https://github.com/grafana/k6/releases/download/v2.0.0/k6-v2.0.0-windows-amd64.zip',
    );
    expect(RUNTIMES.k6.innerDir('2.0.0', 'win32-x64')).toBe('k6-v2.0.0-windows-amd64');
  });

  it('builds the task and node URLs', () => {
    expect(RUNTIMES.task.url('3.51.1', 'win32-x64')).toBe(
      'https://github.com/go-task/task/releases/download/v3.51.1/task_windows_amd64.zip',
    );
    expect(RUNTIMES.node.url('26.9.0', 'win32-x64')).toBe(
      'https://nodejs.org/dist/v26.9.0/node-v26.9.0-win-x64.zip',
    );
  });
});

describe('version parsing', () => {
  it('parses host k6 and task output', () => {
    expect(parseK6Version('k6.exe v2.0.0 (commit/8c3be52cc1, go1.26.3, windows/amd64)')).toBe(
      '2.0.0',
    );
    expect(parseTaskVersion('3.51.1\n')).toBe('3.51.1');
    expect(parseK6Version('garbage')).toBeNull();
  });

  it('parses volta.node and .python-version', () => {
    expect(parseVoltaNode('{"volta":{"node":"26.9.0","pnpm":"11.23.0"}}')).toBe('26.9.0');
    expect(parseVoltaNode('{"volta":{}}')).toBeNull();
    expect(parseVoltaNode('not json')).toBeNull();
    expect(parsePythonVersion('# pin\n3.14\n')).toBe('3.14');
    expect(parsePythonVersion('3.14.4')).toBe('3.14.4');
    expect(parsePythonVersion('latest')).toBeNull();
  });

  it('reads volta.node from the workspace package.json', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"volta":{"node":"26.1.2"}}');
    expect(readNodeVersion(dir)).toBe('26.1.2');
  });

  it('falls back when the host binary is missing', async () => {
    const exec: Exec = async () => fail;
    expect(await resolveRuntimeVersion('k6', dir, exec)).toBe(K6_VERSION_FALLBACK);
    expect(await resolveRuntimeVersion('task', dir, exec)).toBe(TASK_VERSION_FALLBACK);
  });

  it('uses the host version when present', async () => {
    const exec: Exec = async (cmd) => ok(cmd === 'k6' ? 'k6 v1.9.9 (x)' : '3.40.0');
    expect(await resolveRuntimeVersion('k6', dir, exec)).toBe('1.9.9');
    expect(await resolveRuntimeVersion('task', dir, exec)).toBe('3.40.0');
  });
});

describe('downloadToCache', () => {
  it('writes the body and reuses the cached file', async () => {
    const dest = path.join(dir, 'a', 'k6.zip');
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return new Response(new Uint8Array([1, 2, 3]));
    };
    expect(await downloadToCache(fetchFn, 'https://x/k6.zip', dest)).toBeUndefined();
    expect(await downloadToCache(fetchFn, 'https://x/k6.zip', dest)).toBeUndefined();
    expect(calls).toBe(1);
    expect(fs.readFileSync(dest)).toHaveLength(3);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it('fails on non-2xx and on an empty body without leaving files', async () => {
    const dest = path.join(dir, 'b', 'k6.zip');
    const notFound = async () => new Response('nope', { status: 404 });
    expect(await downloadToCache(notFound, 'https://x/k6.zip', dest)).toMatchObject({
      code: 'RUNTIME_FETCH_FAILED',
    });
    const empty = async () => new Response(new Uint8Array([]));
    expect(await downloadToCache(empty, 'https://x/k6.zip', dest)).toMatchObject({
      code: 'RUNTIME_FETCH_FAILED',
    });
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it('reports a network error with the URL', async () => {
    const boom = async (): Promise<Response> => {
      throw new Error('offline');
    };
    const err = await downloadToCache(boom, 'https://x/k6.zip', path.join(dir, 'c.zip'));
    expect(err?.message).toContain('https://x/k6.zip');
  });
});

describe('vendorRuntime', () => {
  it('extracts once into the cache and copies the inner dir into the bundle', async () => {
    let tarCalls = 0;
    const exec: Exec = async (_cmd, args) => {
      tarCalls += 1;
      const dest = args[args.indexOf('-C') + 1] ?? '';
      const inner = path.join(dest, 'k6-v2.0.0-windows-amd64');
      fs.mkdirSync(inner, { recursive: true });
      fs.writeFileSync(path.join(inner, 'k6.exe'), 'exe');
      return ok('');
    };
    const fetchFn = async () => new Response(new Uint8Array([9]));
    const runtimeDir = path.join(dir, 'bundle', 'runtime', 'k6');
    const opts = {
      workspaceRoot: dir,
      runtimeDir,
      platform: 'win32-x64' as const,
      version: '2.0.0',
      exec,
      fetch: fetchFn,
    };
    expect(await vendorRuntime(RUNTIMES.k6, opts)).toBeUndefined();
    expect(await vendorRuntime(RUNTIMES.k6, opts)).toBeUndefined();
    expect(tarCalls).toBe(1);
    expect(fs.existsSync(path.join(runtimeDir, 'k6.exe'))).toBe(true);
    expect(fs.readFileSync(path.join(runtimeDir, 'LICENSE-NOTE.txt'), 'utf8')).toContain('AGPL');
    expect(fs.existsSync(path.join(downloadCacheDir(dir, 'k6', '2.0.0'), 'extracted'))).toBe(true);
  });

  it('reports RUNTIME_EXTRACT_FAILED when the binary is not in the archive', async () => {
    const exec: Exec = async () => ok('');
    const fetchFn = async () => new Response(new Uint8Array([9]));
    const err = await vendorRuntime(RUNTIMES.k6, {
      workspaceRoot: dir,
      runtimeDir: path.join(dir, 'r'),
      platform: 'win32-x64',
      version: '2.0.0',
      exec,
      fetch: fetchFn,
    });
    expect(err).toMatchObject({ code: 'RUNTIME_EXTRACT_FAILED' });
  });
});

describe('pickCpythonDir', () => {
  it('picks the newest concrete dir for the pin and skips the minor junction', () => {
    const names = [
      'cpython-3.14-windows-x86_64-none',
      'cpython-3.14.2-windows-x86_64-none',
      'cpython-3.14.10-windows-x86_64-none',
      'cpython-3.13.9-windows-x86_64-none',
      'cpython-3.14.4-linux-x86_64-gnu',
      '.lock',
    ];
    expect(pickCpythonDir(names, '3.14', 'win32-x64')).toEqual({
      name: 'cpython-3.14.10-windows-x86_64-none',
      version: '3.14.10',
    });
    expect(pickCpythonDir(names, '3.14.2', 'win32-x64')?.version).toBe('3.14.2');
    expect(pickCpythonDir(names, '3.15', 'win32-x64')).toBeNull();
  });
});

describe('vendorPython', () => {
  it('runs uv python install into the download cache and copies the concrete dir', async () => {
    fs.writeFileSync(path.join(dir, '.python-version'), '3.14\n');
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      const installDir = args[args.indexOf('--install-dir') + 1] ?? '';
      fs.mkdirSync(path.join(installDir, 'cpython-3.14.4-windows-x86_64-none'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(installDir, 'cpython-3.14.4-windows-x86_64-none', 'python.exe'),
        'py',
      );
      return ok('');
    };
    const runtimeDir = path.join(dir, 'b', 'runtime', 'python');
    const res = await vendorPython({ workspaceRoot: dir, runtimeDir, platform: 'win32-x64', exec });
    expect(res).toEqual({ version: '3.14.4' });
    expect(calls[0]?.slice(0, 4)).toEqual(['uv', 'python', 'install', '3.14']);
    expect(calls[0]).toContain(path.join(dir, PYTHON_INSTALL_REL));
    expect(calls[0]).toContain('--no-bin');
    expect(fs.existsSync(path.join(runtimeDir, 'python.exe'))).toBe(true);
    expect(fs.readFileSync(path.join(runtimeDir, 'LICENSE-NOTE.txt'), 'utf8')).toContain('PSF');
  });

  it('fails without a pin, on a uv error and when no concrete dir appears', async () => {
    const opts = {
      workspaceRoot: dir,
      runtimeDir: path.join(dir, 'r'),
      platform: 'win32-x64' as const,
    };
    const okExec: Exec = async () => ok('');
    const failExec: Exec = async () => fail;
    expect(await vendorPython({ ...opts, exec: okExec })).toMatchObject({
      code: 'RUNTIME_FETCH_FAILED',
    });
    fs.writeFileSync(path.join(dir, '.python-version'), '3.14\n');
    expect(await vendorPython({ ...opts, exec: failExec })).toMatchObject({
      code: 'RUNTIME_FETCH_FAILED',
    });
    expect(await vendorPython({ ...opts, exec: okExec })).toMatchObject({
      code: 'RUNTIME_EXTRACT_FAILED',
    });
  });
});

describe('tesseract helpers', () => {
  it('parses a scoop shim path and the tesseract version', () => {
    expect(parseShimPath('path = "C:\\scoop\\apps\\tesseract\\current\\tesseract.exe"\n')).toBe(
      'C:\\scoop\\apps\\tesseract\\current\\tesseract.exe',
    );
    expect(parseShimPath('path = C:\\t\\tesseract.exe\r\nargs = -x\r\n')).toBe(
      'C:\\t\\tesseract.exe',
    );
    expect(parseShimPath('args = -x\n')).toBeNull();
    expect(parseTesseractVersion('tesseract v5.5.0.20241111\n leptonica-1.85.0')).toBe(
      '5.5.0.20241111',
    );
    expect(parseTesseractVersion('nothing')).toBeNull();
  });

  function hostTesseract(langs: readonly string[]): { exec: Exec; shim: string } {
    const app = path.join(dir, 'apps', 'tesseract');
    fs.mkdirSync(path.join(app, 'tessdata', 'configs'), { recursive: true });
    fs.writeFileSync(path.join(app, 'tesseract.exe'), 'exe');
    fs.writeFileSync(path.join(app, 'libtesseract-5.dll'), 'dll');
    fs.writeFileSync(path.join(app, 'training.exe'), 'skip');
    fs.writeFileSync(path.join(app, 'tessdata', 'configs', 'hocr'), 'cfg');
    for (const l of langs) fs.writeFileSync(path.join(app, 'tessdata', `${l}.traineddata`), l);
    const shims = path.join(dir, 'shims');
    fs.mkdirSync(shims, { recursive: true });
    const shim = path.join(shims, 'tesseract.exe');
    fs.writeFileSync(shim, 'shim');
    fs.writeFileSync(
      path.join(shims, 'tesseract.shim'),
      `path = "${path.join(app, 'tesseract.exe')}"\n`,
    );
    const exec: Exec = async (cmd) =>
      cmd === 'where' ? ok(`${shim}\r\n`) : ok('tesseract v5.5.0.20241111\n');
    return { exec, shim };
  }

  it('resolves the scoop shim and copies exe, DLLs, eng + tha and configs', async () => {
    const { exec } = hostTesseract(['eng', 'tha']);
    expect(await resolveHostTesseract(exec)).toBe(
      path.join(dir, 'apps', 'tesseract', 'tesseract.exe'),
    );
    const runtimeDir = path.join(dir, 'b', 'runtime', 'tesseract');
    expect(await vendorTesseract({ runtimeDir, exec })).toEqual({ version: '5.5.0.20241111' });
    expect(fs.readFileSync(path.join(runtimeDir, 'tesseract.exe'), 'utf8')).toBe('exe');
    expect(fs.existsSync(path.join(runtimeDir, 'libtesseract-5.dll'))).toBe(true);
    expect(fs.existsSync(path.join(runtimeDir, 'training.exe'))).toBe(false);
    for (const f of ['eng.traineddata', 'tha.traineddata', path.join('configs', 'hocr')]) {
      expect(fs.existsSync(path.join(runtimeDir, 'tessdata', f))).toBe(true);
    }
    expect(fs.existsSync(path.join(runtimeDir, 'tessdata', 'osd.traineddata'))).toBe(false);
    expect(fs.readFileSync(path.join(runtimeDir, 'LICENSE-NOTE.txt'), 'utf8')).toContain(
      'Apache-2.0',
    );
  });

  it('reports TESSDATA_MISSING without tha and TESSERACT_NOT_FOUND without a host binary', async () => {
    const runtimeDir = path.join(dir, 'r');
    const { exec } = hostTesseract(['eng']);
    expect(await vendorTesseract({ runtimeDir, exec })).toMatchObject({ code: 'TESSDATA_MISSING' });
    expect(fs.existsSync(runtimeDir)).toBe(false);
    expect(await vendorTesseract({ runtimeDir, exec: async () => fail })).toMatchObject({
      code: 'TESSERACT_NOT_FOUND',
    });
  });
});

describe('runtimeNote', () => {
  it('covers downloaded and host-sourced runtimes', () => {
    expect(runtimeNote('task')?.license).toBe('MIT');
    expect(runtimeNote('python')?.license).toBe('PSF-2.0');
    expect(runtimeNote('tesseract')?.license).toBe('Apache-2.0');
    expect(runtimeNote('nope')).toBeUndefined();
  });
});
