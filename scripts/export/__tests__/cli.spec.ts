import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BundleExport } from '../bundle.js';
import {
  type CliDeps,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  isUnexpectedWorkspaceTarget,
  parseCliArgs,
  runCli,
} from '../cli.js';

const ws = path.resolve('/ws');
const out = path.resolve('/elsewhere/bundle');

function capture(extra: Partial<CliDeps> = {}): {
  deps: CliDeps;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    deps: {
      workspaceRoot: ws,
      io: { out: (l) => stdout.push(l), err: (l) => stderr.push(l) },
      ...extra,
    },
    stdout,
    stderr,
  };
}

const args = (kind: string, more: string[] = []) => [
  kind,
  '--tool',
  'k6',
  '--type',
  'performance',
  '--project',
  'demo',
  '--out',
  out,
  ...more,
];

const okBundle: BundleExport = {
  tool: 'k6',
  type: 'performance',
  project: 'demo',
  targetDir: out,
  mode: 'fresh',
  written: [],
  kind: 'bundle',
  platform: 'win32-x64',
  runtimes: { k6: '2.0.0' },
  entry: 'automations/specs/rest/e2e.spec.ts',
  sizeBytes: 2 * 1024 * 1024,
  envIncluded: false,
};

describe('parseCliArgs', () => {
  it('parses a full bundle command', () => {
    expect(parseCliArgs(args('bundle', ['--with-env', '--zip']))).toEqual({
      kind: 'bundle',
      tool: 'k6',
      type: 'performance',
      project: 'demo',
      out,
      withEnv: true,
      zip: true,
    });
  });

  it.each([
    [['bundle'], 'missing'],
    [['zip-it', '--tool', 'k6'], 'first argument'],
    [args('bundle', ['--bogus']), 'bogus'],
    [args('standalone', ['--zip']), 'bundle'],
    [['bundle', '--tool', 'k6', '--type', 'p', '--project', 'a/../b', '--out', out], 'unsafe'],
    [['bundle', '--tool', 'k6', '--type', 'p', '--project', 'x', '--out', 'rel'], 'absolute'],
  ])('rejects %j', (argv, message) => {
    const res = parseCliArgs(argv);
    expect('error' in res && res.error).toContain(message);
  });
});

describe('isUnexpectedWorkspaceTarget', () => {
  it('flags only in-workspace targets outside .cache/ and outputs/', () => {
    expect(isUnexpectedWorkspaceTarget(ws, path.join(ws, 'tools', 'x'))).toBe(true);
    expect(isUnexpectedWorkspaceTarget(ws, path.join(ws, '.cache', 'deletable', 'b'))).toBe(false);
    expect(isUnexpectedWorkspaceTarget(ws, path.join(ws, 'outputs', 'b'))).toBe(false);
    expect(isUnexpectedWorkspaceTarget(ws, out)).toBe(false);
  });
});

describe('runCli exit codes', () => {
  it('returns 2 on a usage error', async () => {
    const c = capture();
    expect(await runCli(['bundle'], c.deps)).toBe(EXIT_USAGE);
    expect(c.stderr.join('\n')).toContain('usage:');
  });

  it('returns 0 and prints stage lines on success', async () => {
    const c = capture({
      exportBundle: async (o) => {
        o.onStage?.('validate');
        o.onStage?.('zip');
        return { result: okBundle, resynced: false, regeneratedFiles: [] };
      },
    });
    expect(await runCli(args('bundle'), c.deps)).toBe(EXIT_OK);
    expect(c.stdout).toContain('[bundle 1/12] validate');
    expect(c.stdout).toContain('[bundle 12/12] zip');
    expect(c.stdout.join('\n')).toContain('2.0 MB');
  });

  it('returns 2 for validation codes and 1 for export failures', async () => {
    const failWith = (code: 'SOURCE_MISSING' | 'DEPS_INSTALL_FAILED') =>
      capture({ exportBundle: async () => ({ code, message: 'x' }) }).deps;
    expect(await runCli(args('bundle'), failWith('SOURCE_MISSING'))).toBe(EXIT_USAGE);
    expect(await runCli(args('bundle'), failWith('DEPS_INSTALL_FAILED'))).toBe(EXIT_FAILED);
  });

  it('runs a standalone export and warns about an install error', async () => {
    const c = capture({
      exportStandalone: async () => ({
        result: {
          tool: 'k6',
          type: 'performance',
          project: 'demo',
          targetDir: out,
          mode: 'fresh',
          written: [],
          installError: { code: 'INSTALL_FAILED', message: 'offline' },
        },
        resynced: false,
        regeneratedFiles: [],
      }),
    });
    expect(await runCli(args('standalone'), c.deps)).toBe(EXIT_OK);
    expect(c.stderr.join('\n')).toContain('INSTALL_FAILED');
  });
});
