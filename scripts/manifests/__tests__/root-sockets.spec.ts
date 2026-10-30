import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderRootCompose, renderTaskfileIncludes, TOOLS_CLEAN_TASK } from '../root-sockets.js';
import type { ToolManifest } from '../types.js';

function fakeTool(
  id: string,
  ns: string,
  services?: string,
  extra: Partial<Pick<ToolManifest, 'env' | 'clean'>> = {},
): ToolManifest {
  return {
    id,
    taskfile: 'Taskfile.yml',
    runner: { taskNamespace: ns },
    compose: { template: 't.yml', anchor: 'a', networks: [], services },
    ...extra,
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
    const taskfile = renderTaskfileIncludes(root, [fakeTool('a', 'aa')]);
    expect(taskfile).not.toContain('includes:');
    expect(taskfile).toContain(
      `tasks:\n  ${TOOLS_CLEAN_TASK}:\n    internal: true\n    cmds: []\n`,
    );
    expect(renderRootCompose(root, [fakeTool('a', 'aa', 's.yml')])).toContain('services: {}');
  });

  it('renders env defaults of present tools only, first id wins on a clash', () => {
    const root = workspaceWith(['tools/a/Taskfile.yml', 'tools/b/Taskfile.yml']);
    const out = renderTaskfileIncludes(root, [
      fakeTool('b', 'bb', undefined, { env: { SHARED: 'from-b' } }),
      fakeTool('a', 'aa', undefined, { env: { CACHE_DIR: '{root}/.cache/x', SHARED: 'from-a' } }),
      fakeTool('c', 'cc', undefined, { env: { ABSENT: 'no' } }),
    ]);
    expect(out).toContain('env:\n  CACHE_DIR: "{{.ROOT_DIR}}/.cache/x"\n  SHARED: "from-a"\n');
    expect(out).not.toContain('from-b');
    expect(out).not.toContain('ABSENT');
  });

  it('renders clean paths and best-effort commands per present tool', () => {
    const root = workspaceWith(['tools/a/Taskfile.yml']);
    const out = renderTaskfileIncludes(root, [
      fakeTool('a', 'aa', undefined, {
        clean: { paths: ['test-results', 'report'], commands: ['docker exec svc true'] },
      }),
    ]);
    expect(out).toContain(
      '      - "node scripts/lib/rm-matching-dirs.mjs ./tools/a --names test-results,report --prune .venv,node_modules"\n',
    );
    expect(out).toContain(
      '      - cmd: "cd ./tools/a && docker exec svc true"\n        ignore_error: true\n',
    );
  });

  it('includes a tool compose services file only when it exists', () => {
    const root = workspaceWith(['tools/k/s.yml']);
    const out = renderRootCompose(root, [fakeTool('k', 'k', 's.yml'), fakeTool('p', 'p')]);
    expect(out).toContain('include:\n  - ./tools/k/s.yml\n');
  });
});
