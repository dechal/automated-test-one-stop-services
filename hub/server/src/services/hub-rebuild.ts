import { spawn } from 'node:child_process';
import path from 'node:path';
import { WORKSPACE_ROOT } from '../config.js';
import { runChild } from './exec.js';

/**
 * Rebuild + restart of the Hub itself, in ONE place.
 *
 * Two endpoints need it — `POST /api/system/update` (pull the Hub's own new code)
 * and `POST /api/projects/pull-all` (rebuild when a pull touched hub/ or scripts/).
 * They had a copy each: same two build commands, the same win32 shell flag, the
 * same detached launcher spawn, and a comment in the second one admitting it
 * "mirrors" the first. A change to the build order had to be made twice.
 *
 * The callers keep their OWN state objects and their own stage vocabulary
 * (`client`/`server` vs `building-client`/`building-server`) — those strings are
 * part of each endpoint's public response, so they are mapped by the caller
 * through `onStage` rather than unified here.
 */

/** Which package is being built. The value is also its directory under `hub/`. */
export type RebuildStage = 'client' | 'server';

export interface RebuildResult {
  readonly ok: boolean;
  /** Which build failed. Absent when `ok`. */
  readonly failedAt?: RebuildStage;
  /** Combined output of the failing build, for the caller's error message. */
  readonly output?: string;
}

const HUB_DIR = path.resolve(WORKSPACE_ROOT, 'hub');

/**
 * On Windows `pnpm` is a `.cmd` shim, so it is only resolvable through a shell.
 * Elsewhere the argv form is used, which needs no shell.
 */
const BUILD_SHELL = process.platform === 'win32';

/** Build order is fixed: the client bundle first, then the server that serves it. */
const STAGES: readonly RebuildStage[] = ['client', 'server'];

/**
 * Build `hub/client` then `hub/server`, stopping at the first failure.
 *
 * `onStage` fires BEFORE each build starts, so a caller can publish its own
 * progress value while the build runs. Never throws: a failed build comes back as
 * `{ ok: false, failedAt, output }`.
 */
export async function rebuildHub(onStage?: (stage: RebuildStage) => void): Promise<RebuildResult> {
  for (const stage of STAGES) {
    onStage?.(stage);
    // `hub/${stage}` is the package directory — `client` → hub/client, `server` → hub/server.
    const build = await runChild('pnpm', ['-C', `hub/${stage}`, 'run', 'build'], {
      cwd: WORKSPACE_ROOT,
      shell: BUILD_SHELL,
    });
    if (!build.ok) return { ok: false, failedAt: stage, output: build.output };
  }
  return { ok: true };
}

/**
 * Restart the Hub through the shared launcher (`hub/bin/hub-service.mjs`), so the
 * swap works whether it runs daemonless or under an OS supervisor
 * (Scheduled Task / systemd / launchd).
 *
 * Detached on purpose: this process is about to be killed by the restart. The
 * delay gives the caller's status endpoint one last poll before that happens, so
 * the UI can show "restarting" instead of a dropped connection with no reason.
 * `onError` reports a launcher/node that could not even be spawned — the one
 * failure mode that leaves the old process alive and needs to stay visible.
 */
export function scheduleHubRestart(onError: (message: string) => void, delayMs = 500): void {
  setTimeout(() => {
    const launcher = path.join(HUB_DIR, 'bin', 'hub-service.mjs');
    const child = spawn(process.execPath, [launcher, 'restart'], {
      cwd: HUB_DIR,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (err: Error) => onError(`hub restart failed: ${err.message}`));
    child.unref();
  }, delayMs);
}
