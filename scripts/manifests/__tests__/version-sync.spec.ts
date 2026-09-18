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

describe('syncToolPackageManager — the pnpm pin is derived from versions.env', () => {
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

  it('skips when versions.env has no PNPM_VERSION', () => {
    const t = makePnpmTool('playwright', 'pnpm@11.10.0');
    expect(syncToolPackageManager(t.root, t.manifest, '')).toBeNull();
  });
});

describe('readPnpmVersion', () => {
  it('reads PNPM_VERSION from scripts/setup/versions.env', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-ver-'));
    const dir = path.join(root, 'scripts', 'setup');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'versions.env'),
      'NODE_VERSION=26.9.0\nPNPM_VERSION=11.23.0\n',
      'utf8',
    );
    expect(readPnpmVersion(root)).toBe('11.23.0');
  });

  it('returns an empty string when versions.env is absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-ver-'));
    expect(readPnpmVersion(root)).toBe('');
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
