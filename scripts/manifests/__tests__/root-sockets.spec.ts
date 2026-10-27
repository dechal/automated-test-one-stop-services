import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderRootCompose, renderTaskfileIncludes } from '../root-sockets.js';
import type { ToolManifest } from '../types.js';

function fakeTool(id: string, ns: string, services?: string): ToolManifest {
  return {
    id,
    taskfile: 'Taskfile.yml',
    runner: { taskNamespace: ns },
    compose: { template: 't.yml', anchor: 'a', networks: [], services },
  } as unknown as ToolManifest;
}

function workspaceWith(files: readonly string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-sockets-'));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), '');
  }
  return root;
}

describe('root sockets', () => {
  it('includes only tools whose Taskfile is on disk, keyed by namespace', () => {
    const root = workspaceWith(['tools/b/Taskfile.yml']);
    const out = renderTaskfileIncludes(root, [fakeTool('a', 'aa'), fakeTool('b', 'bb')]);
    expect(out).toContain('  bb:\n    taskfile: ./tools/b/Taskfile.yml\n    dir: ./tools/b\n');
    expect(out).not.toContain('aa:');
  });

  it('emits a valid empty Taskfile and compose when no tool is present', () => {
    const root = workspaceWith([]);
    expect(renderTaskfileIncludes(root, [fakeTool('a', 'aa')])).toContain('tasks: {}');
    expect(renderRootCompose(root, [fakeTool('a', 'aa', 's.yml')])).toContain('services: {}');
  });

  it('includes a tool compose services file only when it exists', () => {
    const root = workspaceWith(['tools/k/s.yml']);
    const out = renderRootCompose(root, [fakeTool('k', 'k', 's.yml'), fakeTool('p', 'p')]);
    expect(out).toContain('include:\n  - ./tools/k/s.yml\n');
  });
});
