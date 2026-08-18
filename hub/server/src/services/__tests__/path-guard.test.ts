import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { OUTPUTS_DIR, WORKSPACE_ROOT } from '../../config.js';
import { isUnder, isUnderOutputs, isUnderWorkspace } from '../path-guard.js';

// path-guard is the ONLY thing between a client-supplied filesystem path and the
// disk: the reveal / reports / testcases / artifacts routes accept an absolute
// path and gate it through these three functions. It had no direct test, so the
// cases below pin the security property itself — "nothing outside the root may
// pass" — rather than the implementation.

const root = path.resolve('/srv/app');

describe('isUnder — the containment property', () => {
  it('accepts the root itself', () => {
    expect(isUnder(root, root)).toBe(true);
  });

  it('accepts a nested descendant', () => {
    expect(isUnder(root, path.join(root, 'a', 'b', 'c.txt'))).toBe(true);
  });

  it('rejects the parent directory and an unrelated tree', () => {
    expect(isUnder(root, path.dirname(root))).toBe(false);
    expect(isUnder(root, path.resolve('/etc/passwd'))).toBe(false);
  });

  it('rejects a sibling whose name merely STARTS WITH the root name', () => {
    // The separator check is what makes this false. Without it `/srv/app-evil`
    // passes a naive startsWith(root) and every guarded route leaks one level up.
    expect(isUnder(root, `${root}-evil`)).toBe(false);
    expect(isUnder(root, `${root}-evil/secret.txt`)).toBe(false);
  });

  it('rejects `..` that escapes the root, however deeply it is buried', () => {
    expect(isUnder(root, path.join(root, '..'))).toBe(false);
    expect(isUnder(root, path.join(root, '..', 'other', 'file.txt'))).toBe(false);
    expect(isUnder(root, path.join(root, 'a', 'b', '..', '..', '..', 'file.txt'))).toBe(false);
  });

  it('accepts `..` that resolves back INSIDE the root', () => {
    expect(isUnder(root, path.join(root, 'a', '..', 'b.txt'))).toBe(true);
  });

  it('resolves a relative target against the process cwd, not against the root', () => {
    // A relative path is NOT interpreted as root-relative — the guard answers
    // "where does this actually land", so callers cannot smuggle one in.
    expect(isUnder(process.cwd(), 'sub/file.txt')).toBe(true);
    expect(isUnder(root, 'sub/file.txt')).toBe(false);
  });

  it('normalises a trailing separator on the root', () => {
    expect(isUnder(`${root}${path.sep}`, path.join(root, 'a.txt'))).toBe(true);
  });
});

describe('isUnderOutputs / isUnderWorkspace — the wired roots', () => {
  it('guards the outputs tree, and only it', () => {
    expect(isUnderOutputs(path.join(OUTPUTS_DIR, 'playwright', 'run.json'))).toBe(true);
    expect(isUnderOutputs(`${OUTPUTS_DIR}-evil`)).toBe(false);
    // The workspace root is ABOVE outputs, so it must not pass the outputs guard.
    expect(isUnderOutputs(path.dirname(OUTPUTS_DIR))).toBe(false);
  });

  it('guards the workspace tree and contains the outputs tree', () => {
    expect(isUnderWorkspace(OUTPUTS_DIR)).toBe(true);
    expect(isUnderWorkspace(path.join(WORKSPACE_ROOT, 'tools'))).toBe(true);
    expect(isUnderWorkspace(path.join(WORKSPACE_ROOT, '..', 'elsewhere'))).toBe(false);
  });
});
