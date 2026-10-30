import { type SpawnOptions, spawn } from 'node:child_process';

export interface RunChildOptions {
  /** Working directory. */
  cwd?: string;
  /** Override or supplement environment variables. */
  env?: NodeJS.ProcessEnv;
  /** Pass `true` to run via the platform default shell, or a path (e.g. BASH_PATH). */
  shell?: SpawnOptions['shell'];
  /** Capture stdout/stderr. Default true. */
  capture?: boolean;
  /** Hard timeout in ms. Default no timeout. */
  timeoutMs?: number;
}

export interface RunChildResult {
  ok: boolean;
  /** Process exit code. -1 when killed by signal or spawn failed. */
  code: number;
  stdout: string;
  stderr: string;
  /** Combined stdout + stderr in chronological order — useful for command logs. */
  output: string;
  /** Set when the process was killed by the timeout. */
  timedOut?: boolean;
}

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

/**
 * Single shared `spawn → Promise` helper used by every server route/service that
 * needs to run a CLI. Centralizing this gives us:
 *   - one place to enforce `windowsHide`, `stdio`, env hygiene.
 *   - consistent shape for callers (no more bespoke promise wrappers).
 *   - simple timeout / kill semantics.
 *
 * Pass `args` for argv-style invocation (preferred — avoids shell injection).
 * To keep `cmd === string` shell invocation, pass an empty `args` array and set
 * `shell: BASH_PATH` (or `true`).
 */
export function runChild(
  cmd: string,
  args: string[] = [],
  options: RunChildOptions = {},
): Promise<RunChildResult> {
  const { cwd, env, shell, capture = true, timeoutMs } = options;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let output = '';
    let timedOut = false;
    // Both 'error' and 'close' can fire for the same process; resolve only
    // on the first event so callers always get a single result.
    let settled = false;
    function settle(result: RunChildResult): void {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    const viaShell = shell !== undefined && shell !== false && args.length > 0;
    const child = spawn(viaShell ? toShellCommand(cmd, args, shell) : cmd, viaShell ? [] : args, {
      cwd,
      env: env ?? process.env,
      shell: shell ?? false,
      windowsHide: true,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    });

    if (capture) {
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
    }

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
