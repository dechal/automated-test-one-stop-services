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
const VERSIONS_ENV = path.join(SETUP_DIR, 'versions.env');
const WIN_SCRIPT = path.join(SETUP_DIR, 'setup-windows.bat');
const NIX_SCRIPT = path.join(SETUP_DIR, 'setup-linux.sh');

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** Pull a KEY=value entry out of versions.env (ignores #-comment lines). */
function readVersion(env: string, key: string): string | undefined {
  return new RegExp(`^${key}=(.+)$`, 'm').exec(env)?.[1]?.trim();
}

describe('single tool-version source of truth (versions.env)', () => {
  const env = read(VERSIONS_ENV);
  const nodeVersion = readVersion(env, 'NODE_VERSION') ?? '';
  const pythonVersion = readVersion(env, 'PYTHON_VERSION') ?? '';
  const pnpmVersion = readVersion(env, 'PNPM_VERSION') ?? '';

  it('versions.env declares NODE_VERSION, PYTHON_VERSION and PNPM_VERSION values', () => {
    expect(nodeVersion).toMatch(/^\d+\.\d+/);
    expect(pythonVersion).toMatch(/^\d+\.\d+/);
    expect(pnpmVersion).toMatch(/^\d+\.\d+/);
  });

  it('NODE_VERSION and PNPM_VERSION stay in sync with the Volta pins in package.json', () => {
    const pkg = JSON.parse(read(path.join(REPO_ROOT, 'package.json'))) as {
      volta?: { node?: string; pnpm?: string };
      packageManager?: string;
    };
    expect(pkg.volta?.node).toBe(nodeVersion);
    expect(pkg.volta?.pnpm).toBe(pnpmVersion);
    expect(pkg.packageManager).toBe(`pnpm@${pnpmVersion}`);
  });

  for (const [label, file] of [
    ['setup-windows.bat', WIN_SCRIPT],
    ['setup-linux.sh', NIX_SCRIPT],
  ] as const) {
    describe(label, () => {
      const body = read(file);

      it('references versions.env', () => {
        expect(body).toContain('versions.env');
      });

      it('does not duplicate the NODE_VERSION / PYTHON_VERSION literals', () => {
        // The literal version numbers must live only in versions.env.
        expect(body).not.toContain(nodeVersion);
        expect(body).not.toContain(pythonVersion);
        // And no inline `NODE_VERSION=<number>` / `PYTHON_VERSION=<number>` assignment.
        expect(body).not.toMatch(/NODE_VERSION\s*=\s*"?\d/);
        expect(body).not.toMatch(/PYTHON_VERSION\s*=\s*"?\d/);
      });
    });
  }
});
