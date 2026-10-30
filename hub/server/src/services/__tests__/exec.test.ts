import { describe, expect, it } from 'vitest';
import { runChild, toShellCommand } from '../exec.js';

describe('toShellCommand', () => {
  it('leaves plain argv untouched', () => {
    expect(toShellCommand('uv', ['sync', '--native-tls'], true, 'win32')).toBe(
      'uv sync --native-tls',
    );
  });

  it('quotes an arg with a space for cmd.exe', () => {
    expect(toShellCommand('pnpm', ['exec', 'C:\\My Dir\\trace.zip'], true, 'win32')).toBe(
      'pnpm exec "C:\\My Dir\\trace.zip"',
    );
  });

  it('quotes for a POSIX shell when the shell is a path', () => {
    expect(toShellCommand('ls', ["it's here"], '/bin/bash', 'win32')).toBe(`ls 'it'\\''s here'`);
  });

  it('quotes an empty arg so it survives', () => {
    expect(toShellCommand('echo', [''], true, 'win32')).toBe('echo ""');
    expect(toShellCommand('echo', [''], true, 'linux')).toBe("echo ''");
  });
});

describe('runChild with shell', () => {
  it('passes an argument containing a space as one argv entry', async () => {
    const res = await runChild(
      process.execPath,
      ['-e', 'process.stdout.write(process.argv[1])', 'a b'],
      { shell: true },
    );
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe('a b');
  });
});
