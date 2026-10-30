import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolManifest } from '../types.js';
import {
  readPnpmVersion,
  readToolVersionPin,
  syncToolPackageManager,
  syncToolVersion,
} from '../version-sync.js';

interface ToolFixture {
  readonly root: string;
  readonly manifestPath: string;
  readonly manifest: ToolManifest;
}

function makeTool(
  id: string,
  manifestVersion: string,
  pinFile: string,
  pinBody: string,
  versionFrom?: { file: string; dependency: string },
): ToolFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'version-sync-'));
  const toolDir = path.join(root, 'tools', id);
  fs.mkdirSync(toolDir, { recursive: true });

  const body = `{\n  "id": "${id}",\n  "version": "${manifestVersion}",\n  "extras": ["a", "b"]\n}\n`;
  const manifestPath = path.join(toolDir, 'tool.manifest.json');
  fs.writeFileSync(manifestPath, body, 'utf8');
  fs.writeFileSync(path.join(toolDir, pinFile), pinBody, 'utf8');

  const manifest = {
    id,
    version: manifestVersion,
    versionFrom: versionFrom ?? { file: pinFile, dependency: '@playwright/test' },
  } as unknown as ToolManifest;

  return { root, manifestPath, manifest };
}

const pkgWith = (spec: string): string =>
  JSON.stringify({ devDependencies: { '@playwright/test': spec } });

describe('syncToolVersion — manifest.version is derived from the tool own pin', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rewrites a stale version and reports the regenerated path', () => {
    const t = makeTool('playwright', '1.60.0', 'package.json', pkgWith('1.63.0'));
    expect(syncToolVersion(t.root, t.manifest)).toBe(
      path.join('tools', 'playwright', 'tool.manifest.json'),
    );
    const after = JSON.parse(fs.readFileSync(t.manifestPath, 'utf8')) as { version: string };
    expect(after.version).toBe('1.63.0');
  });

  it('touches only the version line, leaving every other byte identical', () => {
    const t = makeTool('playwright', '1.60.0', 'package.json', pkgWith('1.63.0'));
    const before = fs.readFileSync(t.manifestPath, 'utf8');
    syncToolVersion(t.root, t.manifest);
    const after = fs.readFileSync(t.manifestPath, 'utf8');

    expect(after).toBe(before.replace('1.60.0', '1.63.0'));
    expect(after).toContain('"extras": ["a", "b"]');
  });

  it('is a no-op when the version already matches the pin', () => {
    const t = makeTool('playwright', '1.63.0', 'package.json', pkgWith('1.63.0'));
    expect(syncToolVersion(t.root, t.manifest)).toBeNull();
  });

  it('strips a range operator before comparing', () => {
    const t = makeTool('playwright', '1.63.0', 'package.json', pkgWith('^1.63.0'));
    expect(syncToolVersion(t.root, t.manifest)).toBeNull();
  });

  it('does nothing for a tool that declares no versionFrom', () => {
    const t = makeTool('k6', 'latest', 'package.json', pkgWith('1.63.0'));
    const manifest = { id: 'k6', version: 'latest' } as unknown as ToolManifest;
    expect(syncToolVersion(t.root, manifest)).toBeNull();
    expect(fs.readFileSync(t.manifestPath, 'utf8')).toContain('"version": "latest"');
  });

  it('warns and leaves the manifest alone when the pin cannot be read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = makeTool('playwright', '1.60.0', 'package.json', JSON.stringify({}));
    expect(syncToolVersion(t.root, t.manifest)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('has no version'));
    expect(fs.readFileSync(t.manifestPath, 'utf8')).toContain('"version": "1.60.0"');
  });

  it('warns and leaves the manifest alone when there is no single version entry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = makeTool('playwright', '1.60.0', 'package.json', pkgWith('1.63.0'));
    fs.writeFileSync(
      t.manifestPath,
      '{\n  "version": "1.60.0",\n  "nested": { "version": "9.9.9" }\n}\n',
      'utf8',
    );
    expect(syncToolVersion(t.root, t.manifest)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('found 2'));
  });
});

function makePnpmTool(
  id: string,
  pkgPackageManager: string,
  packageManager: 'pnpm' | 'uv' | 'none' = 'pnpm',
): { root: string; pkgPath: string; manifest: ToolManifest } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-sync-'));
  const toolDir = path.join(root, 'tools', id);
  fs.mkdirSync(toolDir, { recursive: true });
  const pkgPath = path.join(toolDir, 'package.json');
  fs.writeFileSync(
    pkgPath,
    `{\n  "name": "${id}",\n  "packageManager": "${pkgPackageManager}",\n  "type": "module"\n}\n`,
    'utf8',
  );
  const manifest = { id, packageManager } as unknown as ToolManifest;
  return { root, pkgPath, manifest };
}

describe('syncToolPackageManager — the pnpm pin is derived from the root package.json', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rewrites a stale pnpm pin and reports the path', () => {
    const t = makePnpmTool('playwright', 'pnpm@11.10.0');
    expect(syncToolPackageManager(t.root, t.manifest, '11.23.0')).toBe(
      path.join('tools', 'playwright', 'package.json'),
    );
    const after = JSON.parse(fs.readFileSync(t.pkgPath, 'utf8')) as { packageManager: string };
    expect(after.packageManager).toBe('pnpm@11.23.0');
  });

  it('touches only the packageManager line', () => {
    const t = makePnpmTool('k6', 'pnpm@11.10.0');
    const before = fs.readFileSync(t.pkgPath, 'utf8');
    syncToolPackageManager(t.root, t.manifest, '11.23.0');
    expect(fs.readFileSync(t.pkgPath, 'utf8')).toBe(before.replace('11.10.0', '11.23.0'));
  });

  it('is a no-op when the pin already matches', () => {
    const t = makePnpmTool('playwright', 'pnpm@11.23.0');
    expect(syncToolPackageManager(t.root, t.manifest, '11.23.0')).toBeNull();
  });

  it('skips a non-pnpm tool', () => {
    const t = makePnpmTool('robot-framework', 'pnpm@11.10.0', 'uv');
    expect(syncToolPackageManager(t.root, t.manifest, '11.23.0')).toBeNull();
    expect(fs.readFileSync(t.pkgPath, 'utf8')).toContain('11.10.0');
  });

  it('skips when the root package.json has no pnpm pin', () => {
    const t = makePnpmTool('playwright', 'pnpm@11.10.0');
    expect(syncToolPackageManager(t.root, t.manifest, '')).toBeNull();
  });
});

function makeRoot(pkg: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-ver-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg), 'utf8');
  return root;
}

describe('readPnpmVersion', () => {
  it('reads volta.pnpm from the root package.json', () => {
    const root = makeRoot({ volta: { node: '26.9.0', pnpm: '11.23.0' } });
    expect(readPnpmVersion(root)).toBe('11.23.0');
  });

  it('falls back to packageManager when there is no volta pin', () => {
    const root = makeRoot({ packageManager: 'pnpm@11.23.0' });
    expect(readPnpmVersion(root)).toBe('11.23.0');
  });

  it('returns an empty string when the root package.json is absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-ver-'));
    expect(readPnpmVersion(root)).toBe('');
  });
});

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

function readRepoFile(...segments: string[]): string | undefined {
  const abs = path.join(REPO_ROOT, ...segments);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : undefined;
}

function floorOf(range: string | undefined): string {
  return (range ?? '').replace(/^[^0-9]*/, '').trim();
}

interface RootPins {
  readonly volta?: { readonly node?: string; readonly pnpm?: string };
  readonly engines?: { readonly node?: string; readonly pnpm?: string };
  readonly packageManager?: string;
}

describe('version pins have one source and every copy agrees (G-04)', () => {
  const pkg = JSON.parse(readRepoFile('package.json') ?? '{}') as RootPins;
  const node = pkg.volta?.node ?? '';
  const pnpm = pkg.volta?.pnpm ?? '';
  const python = readRepoFile('.python-version')?.split(/\r?\n/)[0]?.trim() ?? '';

  it('declares the sources: package.json volta.node / volta.pnpm and .python-version', () => {
    expect(node).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pnpm).toMatch(/^\d+\.\d+\.\d+$/);
    expect(python).toMatch(/^\d+\.\d+/);
  });

  it('root package.json engines and packageManager match the volta pins', () => {
    expect(floorOf(pkg.engines?.node)).toBe(node);
    expect(floorOf(pkg.engines?.pnpm)).toBe(pnpm);
    expect(pkg.packageManager).toBe(`pnpm@${pnpm}`);
  });

  it('pyproject.toml requires-python floor matches .python-version', () => {
    const requires = /^requires-python\s*=\s*"([^"]+)"/m.exec(readRepoFile('pyproject.toml') ?? '');
    expect(floorOf(requires?.[1])).toBe(python);
  });

  it('a PYTHON_VERSION left in scripts/setup/versions.env matches .python-version', () => {
    const env = readRepoFile('scripts', 'setup', 'versions.env') ?? '';
    const copy = /^PYTHON_VERSION=(.+)$/m.exec(env)?.[1]?.trim();
    if (copy !== undefined) expect(copy).toBe(python);
    expect(env).not.toMatch(/^(NODE|PNPM)_VERSION=/m);
  });

  it('the CI setup action reads the Node pin from a file, or names the same major', () => {
    const action = readRepoFile('.github', 'actions', 'setup', 'action.yml');
    if (action === undefined) return;
    const file = /node-version-file:\s*['"]?([^'"\s]+)/.exec(action)?.[1];
    if (file !== undefined) {
      expect(fs.existsSync(path.join(REPO_ROOT, file))).toBe(true);
    }
    const literal = /node-version:\s*['"]?([^'"\s]+)/.exec(action)?.[1];
    if (literal !== undefined) expect(node.startsWith(`${literal.split('.')[0]}.`)).toBe(true);
    const pnpmLiteral =
      /pnpm\/action-setup@[^\n]*\n\s*with:\s*\n\s*version:\s*['"]?([^'"\s]+)/.exec(action)?.[1];
    if (pnpmLiteral !== undefined) expect(pnpmLiteral).toBe(pnpm);
  });

  it('the tool template package.json pins the same pnpm', () => {
    const template = readRepoFile('tools', 'tool-template-example', 'package.json');
    if (template === undefined) return;
    const pm = (JSON.parse(template) as RootPins).packageManager;
    expect(pm).toBe(`pnpm@${pnpm}`);
  });
});

describe('readToolVersionPin', () => {
  it('reads a python requirement floor by EXACT name, not by prefix', () => {
    const toml = [
      '[project]',
      'dependencies = [',
      '  "robotframework-browser>=19.15.0",',
      '  "robotframework>=7.4.2",',
      ']',
    ].join('\n');
    const t = makeTool('robot-framework', '7.0.0', 'pyproject.toml', toml, {
      file: 'pyproject.toml',
      dependency: 'robotframework',
    });
    const toolDir = path.join(t.root, 'tools', 'robot-framework');
    expect(
      readToolVersionPin(toolDir, { file: 'pyproject.toml', dependency: 'robotframework' }),
    ).toBe('7.4.2');
  });

  it('returns an empty string when the pin file is absent', () => {
    const t = makeTool('playwright', '1.60.0', 'package.json', pkgWith('1.63.0'));
    const toolDir = path.join(t.root, 'tools', 'playwright');
    expect(readToolVersionPin(toolDir, { file: 'absent.json', dependency: 'x' })).toBe('');
  });
});
