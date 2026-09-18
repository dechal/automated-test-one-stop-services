import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { WORKSPACE_ROOT } from '../config.js';
import { type RunChildResult, runChild } from './exec.js';

/**
 * Manages a HOST Appium server process for mobile testing (Option A:
 * host emulator + host appium — Docker is the wrong tool for Android emulators
 * on Windows). The Hub spawns/stops Appium directly so the whole mobile loop
 * stays inside the Hub with no manual terminal commands. The same capability is
 * available headless via `task robot:appium-local` (CLI parity).
 *
 * Loopback-only by default (`--address 127.0.0.1`), matching the Hub's own
 * local-only posture. Port is configurable via `APPIUM_PORT`.
 */
const APPIUM_PORT = Number.parseInt(process.env.APPIUM_PORT || '4723', 10);
const MAX_LOG_LINES = 200;
// Appium ships as `appium.cmd` on Windows, which spawn can't resolve without a
// shell; npm/driver installs need the same treatment.
const USE_SHELL = process.platform === 'win32';

export interface AppiumStatus {
  running: boolean;
  pid: number | null;
  port: number;
  startedAt: string | null;
  logs: string[];
}

class AppiumServerService {
  private child: ChildProcess | null = null;
  private logs: string[] = [];
  private startedAt: string | null = null;
  private busy = false;

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  status(): AppiumStatus {
    return {
      running: this.running,
      pid: this.child?.pid ?? null,
      port: APPIUM_PORT,
      startedAt: this.startedAt,
      logs: this.logs.slice(-50),
    };
  }

  /** True when the `appium` CLI is installed on the host. */
  async isInstalled(): Promise<boolean> {
    const res = await runChild('appium', ['--version'], { timeoutMs: 10_000, shell: USE_SHELL });
    return res.ok;
  }

  start(): { ok: boolean; message: string } {
    if (this.running) return { ok: true, message: 'Appium already running' };
    if (this.busy) return { ok: false, message: 'Appium is busy (install or stop in progress)' };
    this.logs = [];
    const child = spawn(
      'appium',
      ['--address', '127.0.0.1', '--port', String(APPIUM_PORT), '--relaxed-security'],
      {
        cwd: WORKSPACE_ROOT,
        shell: USE_SHELL,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    this.child = child;
    this.startedAt = new Date().toISOString();

    const capture = (buf: Buffer): void => {
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        this.logs.push(line);
        if (this.logs.length > MAX_LOG_LINES) this.logs.shift();
      }
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.on('error', (err) => this.logs.push(`[error] ${err.message}`));
    child.on('exit', () => {
      this.child = null;
      this.startedAt = null;
    });
    return { ok: true, message: `Appium starting on :${APPIUM_PORT}` };
  }

  async stop(): Promise<{ ok: boolean }> {
    const pid = this.child?.pid;
    this.child = null;
    this.startedAt = null;
    if (!pid) return { ok: true };
    this.busy = true;
    try {
      if (process.platform === 'win32') {
        await new Promise<void>((resolve) => {
          execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () =>
            resolve(),
          );
        });
      } else {
        try {
          process.kill(pid);
        } catch {
          /* already gone */
        }
      }
    } finally {
      this.busy = false;
    }
    return { ok: true };
  }

  /** One-time host provisioning: install Appium + the uiautomator2 driver. */
  async install(): Promise<RunChildResult> {
    this.busy = true;
    try {
      const npmInstall = await runChild('npm', ['i', '-g', 'appium'], {
        timeoutMs: 300_000,
        shell: USE_SHELL,
      });
      if (!npmInstall.ok) return npmInstall;
      return await runChild('appium', ['driver', 'install', 'uiautomator2'], {
        timeoutMs: 300_000,
        shell: USE_SHELL,
      });
    } finally {
      this.busy = false;
    }
  }
}

export const appiumServer = new AppiumServerService();
