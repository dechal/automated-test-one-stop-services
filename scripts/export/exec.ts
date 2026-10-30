import { type SpawnOptions, spawn } from 'node:child_process';

export interface RunChildOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly shell?: SpawnOptions['shell'];
  readonly timeoutMs?: number;
}

export interface RunChildResult {
  readonly ok: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
  readonly timedOut?: boolean;
}

export type Exec = (
  cmd: string,
  args: string[],
  options?: RunChildOptions,
) => Promise<RunChildResult>;

const CMD_SAFE_ARG = /^[\w@+=:,./\\-]+$/;
const POSIX_SAFE_ARG = /^[\w@%+=:,./-]+$/;

function quoteCmdArg(arg: string): string {
  return CMD_SAFE_ARG.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

function quotePosixArg(arg: string): string {
  return POSIX_SAFE_ARG.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function toShellCommand(
  cmd: string,
  args: readonly string[],
  shell: SpawnOptions['shell'],
  platform: NodeJS.Platform = process.platform,
): string {
  const quote = platform === 'win32' && shell === true ? quoteCmdArg : quotePosixArg;
  return [cmd, ...args].map(quote).join(' ');
}

export function runChild(
  cmd: string,
  args: string[] = [],
  options: RunChildOptions = {},
): Promise<RunChildResult> {
  const { cwd, env, shell, timeoutMs } = options;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let output = '';
    let timedOut = false;
    let settled = false;
    const settle = (result: RunChildResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const viaShell = shell !== undefined && shell !== false && args.length > 0;
    const child = spawn(viaShell ? toShellCommand(cmd, args, shell) : cmd, viaShell ? [] : args, {
      cwd,
      env: env ?? process.env,
      shell: shell ?? false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (b: Buffer) => {
      const s = b.toString('utf8');
      stdout += s;
      output += s;
    });
    child.stderr?.on('data', (b: Buffer) => {
      const s = b.toString('utf8');
      stderr += s;
      output += s;
    });
    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
          }, timeoutMs)
        : null;
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      settle({
        ok: false,
        code: -1,
        stdout,
        stderr: stderr || err.message,
        output: output || err.message,
        ...(timedOut ? { timedOut: true } : {}),
      });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const exit = typeof code === 'number' ? code : -1;
      settle({
        ok: exit === 0 && !timedOut,
        code: exit,
        stdout,
        stderr,
        output,
        ...(timedOut ? { timedOut: true } : {}),
      });
    });
  });
}
