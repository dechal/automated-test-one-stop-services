import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ToolManifest } from '../types.js';
import { desiredUvMembers, syncUvWorkspaceMembers } from '../uv-workspace-sync.js';

const PYPROJECT = [
  '[project]',
  'name = "root"',
  '',
  '[tool.uv.workspace]',
  'members = ["tools/robot-framework"]',
  'exclude = [',
  '  "node_modules",',
  ']',
  '',
  '[tool.uv]',
  'package = false',
  '',
  '[tool.ruff]',
  'line-length = 100',
  '',
].join('\n');

function tool(id: string, packageManager: 'uv' | 'pnpm' | 'none'): ToolManifest {
  return { id, packageManager } as unknown as ToolManifest;
}

function repo(toolIds: readonly string[], toml = PYPROJECT): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uv-members-'));
  fs.writeFileSync(path.join(root, 'pyproject.toml'), toml, 'utf8');
  for (const id of toolIds) {
    const dir = path.join(root, 'tools', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "t"\n', 'utf8');
  }
  return root;
}

describe('desiredUvMembers', () => {
  it('includes only uv tools whose folder is actually on disk', () => {
    const root = repo(['robot-framework']);
    expect(
      desiredUvMembers(root, [
        tool('robot-framework', 'uv'),
        tool('playwright', 'pnpm'),
        tool('absent-uv-tool', 'uv'),
      ]),
    ).toEqual(['tools/robot-framework']);
  });

  it('is sorted so the emitted list is deterministic', () => {
    const root = repo(['b-tool', 'a-tool']);
    expect(desiredUvMembers(root, [tool('b-tool', 'uv'), tool('a-tool', 'uv')])).toEqual([
      'tools/a-tool',
      'tools/b-tool',
    ]);
  });
});

describe('syncUvWorkspaceMembers', () => {
  it('is a no-op when the declared member is present', () => {
    const root = repo(['robot-framework']);
    expect(syncUvWorkspaceMembers(root, [tool('robot-framework', 'uv')])).toBeNull();
    expect(fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8')).toBe(PYPROJECT);
  });

  it('drops a member whose folder was deleted by hand, leaving an empty list', () => {
    const root = repo([]);
    expect(syncUvWorkspaceMembers(root, [tool('robot-framework', 'uv')])).toBe('pyproject.toml');

    const after = fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8');
    expect(after).toContain('members = []');
    expect(after).toBe(PYPROJECT.replace('["tools/robot-framework"]', '[]'));
  });

  it('adds a uv tool that is on disk but not yet declared', () => {
    const root = repo(['robot-framework', 'new-py-tool']);
    expect(
      syncUvWorkspaceMembers(root, [tool('robot-framework', 'uv'), tool('new-py-tool', 'uv')]),
    ).toBe('pyproject.toml');
    expect(fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8')).toContain(
      'members = ["tools/new-py-tool", "tools/robot-framework"]',
    );
  });

  it('never touches a sibling array such as exclude, or any other section', () => {
    const root = repo([]);
    syncUvWorkspaceMembers(root, [tool('robot-framework', 'uv')]);
    const after = fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8');

    expect(after).toContain('exclude = [\n  "node_modules",\n]');
    expect(after).toContain('[tool.ruff]\nline-length = 100');
    expect(after).toContain('package = false');
  });

  it('warns and leaves the file alone when the section has no members entry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const toml = '[tool.uv.workspace]\nexclude = []\n';
    const root = repo([], toml);
    expect(syncUvWorkspaceMembers(root, [tool('robot-framework', 'uv')])).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no "members" entry'));
    expect(fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8')).toBe(toml);
    warn.mockRestore();
  });

  it('does nothing when the workspace declares no uv section at all', () => {
    const toml = '[project]\nname = "root"\n';
    const root = repo([], toml);
    expect(syncUvWorkspaceMembers(root, [tool('robot-framework', 'uv')])).toBeNull();
    expect(fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8')).toBe(toml);
  });
});
