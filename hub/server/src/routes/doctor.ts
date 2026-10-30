import fs from 'node:fs';
import path from 'node:path';
import type { PythonInstallResult } from '@hub/shared';
import type { FastifyInstance } from 'fastify';
import { WORKSPACE_ROOT } from '../config.js';
import { invalidateDoctorCache, readPythonVersion, runDoctor } from '../services/doctor.js';
import { runChild } from '../services/exec.js';
import { getEnabledTools, type ToolManifest } from '../services/manifest-registry.js';

const CREDENTIALS_DIR = path.join(
  WORKSPACE_ROOT,
  'scripts',
  'third-party',
  'google',
  'credentials',
);

/** Keep only the last N chars of a command log — enough to see the real error
 *  without shipping a multi-KB dump to the browser. */
function tail(text: string, max = 800): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

/**
 * Retroactively install the Python toolchain that setup skips when it is
 * unreachable (locked-down proxy, offline first run, …). Runs the SAME commands
 * the setup script would have: `uv python install <version>`, then a best-effort
 * `uv sync` so robot-framework's deps are usable. The interpreter install is the
 * gating result (`ok`); a `uv sync` failure is reported as a non-fatal `message`
 * because the `python` doctor check only verifies the interpreter.
 */
async function installPython(): Promise<PythonInstallResult> {
  const version = readPythonVersion();
  const shell = process.platform === 'win32';
  const installArgs = version
    ? ['python', 'install', version, '--native-tls']
    : ['python', 'install', '--native-tls'];

  const install = await runChild('uv', installArgs, {
    cwd: WORKSPACE_ROOT,
    timeoutMs: 180_000,
    shell,
  });
  if (!install.ok) {
    invalidateDoctorCache();
    return {
      ok: false,
      version: version ?? 'latest',
      error: {
        code: install.timedOut ? 'PYTHON_INSTALL_TIMEOUT' : 'PYTHON_INSTALL_FAILED',
        message: tail(install.output) || 'uv python install failed (is uv installed?)',
      },
    };
  }

  // Best-effort: sync robot-framework's Python deps so the interpreter is
  // immediately usable. A failure here does not undo the interpreter install.
  let message: string | undefined;
  const tools = await getEnabledTools().catch((): readonly ToolManifest[] => []);
  for (const tool of tools.filter((t) => t.packageManager === 'uv')) {
    const toolDir = path.join(WORKSPACE_ROOT, 'tools', tool.id);
    const sync = await runChild('uv', ['sync', '--native-tls', '--project', toolDir], {
      cwd: toolDir,
      timeoutMs: 180_000,
      shell,
    });
    if (!sync.ok) {
      message = `Python ${version ?? ''} installed, but 'uv sync' failed in tools/${tool.id} — run it manually to finish Python tool setup. ${tail(sync.output, 400)}`;
      break;
    }
  }

  invalidateDoctorCache();
  return { ok: true, version: version ?? 'latest', message };
}

export async function doctorRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/doctor — run environment health checks */
  app.get('/api/doctor', async () => {
    return runDoctor();
  });

  /**
   * POST /api/doctor/install-python — retroactively install the Python
   * toolchain that setup skipped. Synchronous (the client sends a long
   * per-request timeout and shows a spinner). A failed interpreter install is
   * reported in-band as `{ ok: false, error }` so the panel can render the
   * cause — mirrors the tool-provision contract.
   */
  app.post('/api/doctor/install-python', async (): Promise<PythonInstallResult> => {
    return installPython();
  });

  /** POST /api/doctor/upload-credentials — upload Google credentials.json */
  app.post('/api/doctor/upload-credentials', async (req, reply) => {
    const body = req.body as { content?: string; filename?: string };
    if (!body.content) {
      reply.status(400);
      return { code: 'MISSING_CONTENT', message: 'File content is required' };
    }

    if (!fs.existsSync(CREDENTIALS_DIR)) {
      fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
    }

    const targetPath = path.join(CREDENTIALS_DIR, 'credentials.json');
    fs.writeFileSync(targetPath, body.content, 'utf8');

    return { ok: true, path: targetPath };
  });
}

export default doctorRoutes;
