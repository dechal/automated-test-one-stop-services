// scripts/manifests/__tests__/versions-source.spec.ts
//
// Single source of truth for node + pnpm is scripts/setup/versions.env. The
// Volta pins in package.json (volta.node / volta.pnpm / packageManager) and every
// tools/* packageManager are kept in sync with it (the tools/* pins by
// `tsx scripts/sync-projects.ts`). A mise migration was attempted and reverted —
// Trellix (org AV) blocks mise/pnpm-12 installs on the dev machines; see the brain
// note pnpm12-volta-and-windows-install. The setup scripts read versions.env and
// must not re-declare a version literal.
//
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const SETUP_DIR = path.join(REPO_ROOT, 'scripts', 'setup');
const WIN_SCRIPT = path.join(SETUP_DIR, 'setup-windows.bat');
const NIX_SCRIPT = path.join(SETUP_DIR, 'setup-linux.sh');

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

describe('single tool-version source of truth (package.json volta + .python-version)', () => {
  const pkg = JSON.parse(read(path.join(REPO_ROOT, 'package.json'))) as {
    volta?: { node?: string; pnpm?: string };
  };
  const nodeVersion = pkg.volta?.node ?? '';
  const pnpmVersion = pkg.volta?.pnpm ?? '';
  const pythonVersion =
    read(path.join(REPO_ROOT, '.python-version')).split(/\r?\n/)[0]?.trim() ?? '';

  it('package.json volta and .python-version declare the node, pnpm and Python versions', () => {
    expect(nodeVersion).toMatch(/^\d+\.\d+/);
    expect(pythonVersion).toMatch(/^\d+\.\d+/);
    expect(pnpmVersion).toMatch(/^\d+\.\d+/);
  });

  for (const [label, file] of [
    ['setup-windows.bat', WIN_SCRIPT],
    ['setup-linux.sh', NIX_SCRIPT],
  ] as const) {
    describe(label, () => {
      const body = read(file);

      it('reads package.json and .python-version, not versions.env', () => {
        expect(body).toContain('package.json');
        expect(body).toContain('.python-version');
        expect(body).not.toMatch(/VERSIONS_FILE/);
      });

      it('does not duplicate the node / pnpm / Python literals', () => {
        // The literal version numbers must live only in versions.env.
        expect(body).not.toContain(nodeVersion);
        expect(body).not.toContain(pnpmVersion);
        expect(body).not.toContain(pythonVersion);
        // And no inline `NODE_VERSION=<number>` / `PYTHON_VERSION=<number>` assignment.
        expect(body).not.toMatch(/NODE_VERSION\s*=\s*"?\d/);
        expect(body).not.toMatch(/PNPM_VERSION\s*=\s*"?\d/);
        expect(body).not.toMatch(/PYTHON_VERSION\s*=\s*"?\d/);
      });
    });
  }
});
