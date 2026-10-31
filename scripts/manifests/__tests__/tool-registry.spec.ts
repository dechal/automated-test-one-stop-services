// scripts/manifests/__tests__/tool-registry.spec.ts
//
// Tests for `loadToolRegistry()` with schema validation.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadToolRegistry } from '../index.js';

describe('loadToolRegistry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty registry when the file does not exist', async () => {
    const result = await loadToolRegistry(tmpDir);
    expect(result).toEqual({ schemaVersion: '1', tools: [] });
  });

  it('loads and validates a well-formed registry file', async () => {
    const registryDir = path.join(tmpDir, 'scripts', 'manifests', 'data');
    fs.mkdirSync(registryDir, { recursive: true });
    const registry = {
      schemaVersion: '1',
      tools: [
        {
          name: 'cypress',
          title: 'Cypress',
          description: 'E2E testing',
          gitUrl: 'https://github.com/internal/qa-cypress-tool.git',
          ref: 'v1.0.0',
        },
        {
          name: 'selenium',
          title: 'Selenium',
          description: 'Browser automation',
          gitUrl: 'git@github.com:internal/qa-selenium-tool.git',
          ref: 'main',
        },
      ],
    };
    fs.writeFileSync(path.join(registryDir, 'tool-registry.json'), JSON.stringify(registry));

    const result = await loadToolRegistry(tmpDir);
    expect(result.schemaVersion).toBe('1');
    expect(result.tools).toHaveLength(2);
    expect(result.tools[0].name).toBe('cypress');
    expect(result.tools[1].name).toBe('selenium');
  });

  it('returns empty registry with console warning for invalid JSON (fail-closed)', async () => {
    const registryDir = path.join(tmpDir, 'scripts', 'manifests', 'data');
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(registryDir, 'tool-registry.json'), 'not valid json{{{');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await loadToolRegistry(tmpDir);
    expect(result).toEqual({ schemaVersion: '1', tools: [] });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Tool registry is not valid JSON'),
    );
    warnSpy.mockRestore();
  });

  it('returns empty registry with console warning when schemaVersion is wrong (fail-closed)', async () => {
    const registryDir = path.join(tmpDir, 'scripts', 'manifests', 'data');
    fs.mkdirSync(registryDir, { recursive: true });
    const registry = { schemaVersion: '99', tools: [] };
    fs.writeFileSync(path.join(registryDir, 'tool-registry.json'), JSON.stringify(registry));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await loadToolRegistry(tmpDir);
    expect(result).toEqual({ schemaVersion: '1', tools: [] });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Tool registry validation failed'),
    );
    warnSpy.mockRestore();
  });

  it('returns empty registry when a tool entry has an invalid name pattern (fail-closed)', async () => {
    const registryDir = path.join(tmpDir, 'scripts', 'manifests', 'data');
    fs.mkdirSync(registryDir, { recursive: true });
    const registry = {
      schemaVersion: '1',
      tools: [
        {
          name: 'INVALID_NAME',
          title: 'Bad',
          description: 'Bad entry',
          gitUrl: 'https://example.com/repo.git',
          ref: 'main',
        },
      ],
    };
    fs.writeFileSync(path.join(registryDir, 'tool-registry.json'), JSON.stringify(registry));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await loadToolRegistry(tmpDir);
    expect(result).toEqual({ schemaVersion: '1', tools: [] });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Tool registry validation failed'),
    );
    warnSpy.mockRestore();
  });

  it('returns empty registry when required fields are missing from a tool entry', async () => {
    const registryDir = path.join(tmpDir, 'scripts', 'manifests', 'data');
    fs.mkdirSync(registryDir, { recursive: true });
    const registry = {
      schemaVersion: '1',
      tools: [{ name: 'some-tool' }],
    };
    fs.writeFileSync(path.join(registryDir, 'tool-registry.json'), JSON.stringify(registry));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await loadToolRegistry(tmpDir);
    expect(result).toEqual({ schemaVersion: '1', tools: [] });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('accepts optional fields (manifestPath, compatibleWith)', async () => {
    const registryDir = path.join(tmpDir, 'scripts', 'manifests', 'data');
    fs.mkdirSync(registryDir, { recursive: true });
    const registry = {
      schemaVersion: '1',
      tools: [
        {
          name: 'my-tool',
          title: 'My Tool',
          description: 'A tool',
          gitUrl: 'https://github.com/org/repo.git',
          ref: 'v2.0.0',
          manifestPath: 'packages/tool/tool.manifest.json',
          compatibleWith: '>=1.0.0',
        },
      ],
    };
    fs.writeFileSync(path.join(registryDir, 'tool-registry.json'), JSON.stringify(registry));

    const result = await loadToolRegistry(tmpDir);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].manifestPath).toBe('packages/tool/tool.manifest.json');
    expect(result.tools[0].compatibleWith).toBe('>=1.0.0');
  });

  it('validates the actual workspace registry file (integration)', async () => {
    const workspaceRoot = path.resolve(__dirname, '../../..');
    const result = await loadToolRegistry(workspaceRoot);
    expect(result.schemaVersion).toBe('1');
    expect(result.tools.length).toBeGreaterThanOrEqual(2);
    expect(result.tools.find((t) => t.name === 'cypress')).toBeDefined();
    expect(result.tools.find((t) => t.name === 'selenium')).toBeDefined();
  });
});
