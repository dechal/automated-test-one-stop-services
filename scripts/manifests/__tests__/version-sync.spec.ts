import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolManifest } from '../types.js';
import { readToolVersionPin, syncToolVersion } from '../version-sync.js';

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
