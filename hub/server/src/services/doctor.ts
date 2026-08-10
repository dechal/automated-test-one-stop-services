import fs from 'node:fs';
import path from 'node:path';
import type { DoctorCategory, DoctorCheck, DoctorReport } from '@hub/shared';
import { SCRIPTS_DIR, TOOLS_DIR, WORKSPACE_ROOT } from '../config.js';
import { getComposeServiceStatus, isDockerRunning } from './docker.js';
import { runChild } from './exec.js';

/**
 * The pinned Python version from `scripts/setup/versions.env` (the single
 * source of truth shared with the setup scripts) — e.g. `"3.14"`. Returns
 * `undefined` when the file or key is absent, so probes/installs degrade to
 * "any Python" instead of hardcoding a version. Never throws.
 */
export function readPythonVersion(): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(SCRIPTS_DIR, 'setup', 'versions.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      if (trimmed.slice(0, eq).trim() === 'PYTHON_VERSION') {
        const value = trimmed.slice(eq + 1).trim();
        return value || undefined;
      }
    }
  } catch {
    // Missing/unreadable versions.env → caller falls back to "any Python".
  }
  return undefined;
}

interface CheckDef {
  name: string;
  cmd: string;
  args: string[];
  hint: string;
  category: DoctorCategory;
}

const CHECKS: CheckDef[] = [
  // Required installs
  {
    name: 'node',
    cmd: 'node',
    args: ['-v'],
    hint: 'Install Node.js via Volta or nvm',
    category: 'required-install',
  },
  {
    name: 'pnpm',
    cmd: 'pnpm',
    args: ['-v'],
    hint: 'Install pnpm: npm i -g pnpm',
    category: 'required-install',
  },
  {
    name: 'uv',
    cmd: 'uv',
    args: ['--version'],
    hint: 'Install uv: pip install uv or see docs.astral.sh/uv',
    category: 'required-install',
  },
  {
    name: 'task',
    cmd: 'task',
    args: ['--version'],
    hint: 'Install Task: scoop install task | brew install go-task | https://taskfile.dev/installation/',
    category: 'required-install',
  },
  {
    name: 'git',
    cmd: 'git',
    args: ['--version'],
    hint: 'Install git: winget install Git.Git',
    category: 'required-install',
  },
  // Optional installs
  {
    name: 'docker',
    cmd: 'docker',
    args: ['--version'],
    hint: 'Install Docker Desktop',
    category: 'optional-install',
  },
  {
    name: 'playwright-cli',
    cmd: 'playwright-cli',
    args: ['--version'],
    hint: 'Install via Volta: volta install playwright-cli',
    category: 'optional-install',
  },
  {
    name: 'appium',
    cmd: 'appium',
    args: ['--version'],
    hint: 'Install from the Hub Services tab (mobile), or: npm i -g appium && appium driver install uiautomator2',
    category: 'optional-install',
  },
];

async function runCheck(def: CheckDef): Promise<DoctorCheck> {
  // Some CLIs (notably `pnpm` on Windows) live as a `.cmd` shim — argv-style
  // spawn with `shell: false` fails to find them. Run with `shell: true` for
  // these probes (we control the argv, so there is no injection vector).
  const res = await runChild(def.cmd, def.args, {
    timeoutMs: PROBE_TIMEOUT_MS,
    shell: process.platform === 'win32',
  });
  if (res.ok) {
    return { name: def.name, ok: true, version: res.stdout.trim(), category: def.category };
  }
  // A timeout says nothing about whether the tool is installed — only that the
  // machine was too busy to answer. Telling the user to install pnpm because
  // `pnpm -v` was slow is worse than saying nothing, so keep the two apart.
  if (res.timedOut) {
    return {
      name: def.name,
      ok: false,
      unverified: true,
      hint: `Could not verify in ${PROBE_TIMEOUT_MS / 1000}s — the machine was busy. Retry when the run finishes.`,
      category: def.category,
    };
  }
  return { name: def.name, ok: false, hint: def.hint, category: def.category };
}

/** Compose-service availability probe with a friendly hint per service. */
async function checkComposeService(
  name: 'influxdb' | 'grafana',
  port: number,
): Promise<DoctorCheck> {
  const status = await getComposeServiceStatus(name);
  if (status === 'running') {
    return {
      name,
      ok: true,
      version: `running on :${port}`,
      category: 'optional-process',
    };
  }
  return {
    name,
    ok: false,
    hint: `Start ${name}: docker compose up ${name} -d`,
    category: 'optional-process',
  };
}

async function checkDockerDaemon(): Promise<DoctorCheck> {
  const ok = await isDockerRunning();
  return ok
    ? { name: 'docker-running', ok: true, version: 'daemon active', category: 'optional-process' }
    : {
        name: 'docker-running',
        ok: false,
        hint: 'Start Docker Desktop or run: sudo systemctl start docker',
        category: 'optional-process',
      };
}

// ── Folder-presence gating ─────────────────
//
// A tool-owned check is mandatory (`required-install`) iff the tool's
// `tools/<id>/` folder is present. When the folder is absent the check becomes a
// benign, passing `optional-install` self-check so it never forces `overallOk`
// false, never auto-expands the dashboard panel, and never prevents another
// component from independently declaring that tool required.
//
// Design note: reuses the existing `optional-install` category instead of adding a
// `not-required` DoctorCategory. `overallOk` (and the client summary badge)
// consider only `required-install`, so `optional-install` yields identical
// overall semantics while avoiding edits to the client's exhaustive
// `Record<DoctorCategory>` consumers (`groupByCategory`, `DOCTOR_CATEGORY_ORDER`)
// which are out of this change's scope. Upgrade path: add `not-required` to the
// union and extend those client maps. Presence uses `fs.existsSync(TOOLS_DIR/id)`
// — the Hub server package cannot import the `scripts/manifests`
// folder-presence helper (not a workspace package; Biome bans the deep relative
// import), and a single `existsSync` is not a discovery-scan re-implementation.

/** True iff `tools/<id>/` exists on disk — the folder-presence gate. */
export function isToolFolderPresent(id: string): boolean {
  return fs.existsSync(path.join(TOOLS_DIR, id));
}

/**
 * The category a folder-presence-gated tool check takes: a mandatory
 * `required-install` when the tool folder is present, otherwise a non-required
 * `optional-install` self-check (`overallOk` ignores it).
 */
export function toolCheckCategory(present: boolean): DoctorCategory {
  return present ? 'required-install' : 'optional-install';
}

/**
 * Overall health: every mandatory (`required-install`) check passes. Checks in
 * any other category never affect the result, so an absent tool's
 * `optional-install` self-check drops out naturally.
 */
export function computeOverallOk(checks: readonly DoctorCheck[]): boolean {
  return checks
    .filter((c) => c.category === 'required-install' && !c.unverified)
    .every((c) => c.ok);
}

/** The benign, passing self-check emitted when a tool's folder is absent. */
function absentToolCheck(name: string, folder: string): DoctorCheck {
  return {
    name,
    ok: true,
    version: `not required (tools/${folder} absent)`,
    category: toolCheckCategory(false),
  };
}

/**
 * k6 binary probe, folder-presence-gated on `tools/k6/`. Present →
 * a mandatory `required-install` probe of the k6 binary; absent → a non-required
 * self-check, so a workstation without the k6 tool never fails the doctor.
 */
async function checkK6(present: boolean): Promise<DoctorCheck> {
  if (!present) return absentToolCheck('k6', 'k6');
  return runCheck({
    name: 'k6',
    cmd: 'k6',
    args: ['version'],
    hint: 'Install k6: winget install Grafana.k6',
    category: 'required-install',
  });
}

/**
 * Python-interpreter probe, folder-presence-gated on `tools/robot-framework`
 * (the only tool that needs Python). Present → a mandatory `required-install`
 * probe via `uv python find <version>`; when it fails (the toolchain was skipped
 * during setup, e.g. behind a locked-down proxy) the check carries
 * `install: 'python'` so the Doctor panel offers a one-click retroactive
 * install. Absent → a benign non-required self-check, so a workstation without
 * robot-framework never fails the doctor over Python.
 */
async function checkPython(present: boolean): Promise<DoctorCheck> {
  if (!present) return absentToolCheck('python', 'robot-framework');
  const version = readPythonVersion();
  // `uv python find` exits 0 (printing the interpreter path) when a matching
  // Python is installed, non-zero otherwise. `uv` owns Python here, so probing
  // through uv is the source-of-truth check the setup script uses.
  const args = version ? ['python', 'find', version] : ['python', 'find'];
  const res = await runChild('uv', args, {
    timeoutMs: 10_000,
    shell: process.platform === 'win32',
  });
  if (res.ok) {
    const label = version ? `${version} (${res.stdout.trim()})` : res.stdout.trim();
    return { name: 'python', ok: true, version: label, category: 'required-install' };
  }
  return {
    name: 'python',
    ok: false,
    hint: version
      ? `Python ${version} not found — click Install Python (uv python install ${version})`
      : 'Python not found — click Install Python (uv python install)',
    category: 'required-install',
    install: 'python',
  };
}

/**
/** True when `dir` exists and holds at least one installed browser (a non-dot
 *  entry like `chromium-1223`). A bare-but-empty cache dir is NOT "installed",
 *  so it correctly reads as missing. */
function hasInstalledBrowsers(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((entry) => !entry.startsWith('.'));
  } catch {
    return false; // not a directory / does not exist
  }
}

/**
 * Playwright browser check, folder-presence-gated on `tools/playwright/`.
 * Present → a mandatory `required-install` probe; absent → a non-required
 * self-check.
 *
 * Resolution matters: the setup scripts install browsers into the
 * **workspace-local** cache `<root>/.cache/playwright-browsers` and export
 * `PLAYWRIGHT_BROWSERS_PATH` to point there, and the tool `.env` uses the
 * relative `.cache/playwright-browsers`. But the Hub server may have been
 * started WITHOUT that env var (Windows `setx` only affects new processes;
 * Linux setup only `export`s it), so we must NOT depend on it. We therefore
 * probe, in order: an explicit env value (resolved against the workspace root
 * so a relative value works), then the workspace cache itself — and never the
 * global `~/.cache/ms-playwright`, which the workspace does not use. This is why
 * a machine with browsers present used to show a false "missing".
 */
function checkPlaywrightBrowsers(present: boolean): DoctorCheck {
  if (!present) return absentToolCheck('playwright-browsers', 'playwright');

  const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const candidates = [
    env ? path.resolve(WORKSPACE_ROOT, env) : undefined,
    path.join(WORKSPACE_ROOT, '.cache', 'playwright-browsers'),
  ].filter((p): p is string => !!p);

  const found = candidates.find(hasInstalledBrowsers);
  if (found) {
    return {
      name: 'playwright-browsers',
      ok: true,
      version: `path: ${found}`,
      category: 'required-install',
    };
  }
  return {
    name: 'playwright-browsers',
    ok: false,
    hint: 'Run: pnpm exec playwright install (or click Provision)',
    category: 'required-install',
  };
}

/** Check if Google credentials file exists for usage logging. */
function checkCredentials(): boolean {
  const credPath = path.join(
    WORKSPACE_ROOT,
    'scripts',
    'third-party',
    'google',
    'credentials',
    'credentials.json',
  );
  return fs.existsSync(credPath);
}

let lastReport: { value: DoctorReport; at: number } | null = null;
/**
 * Per-probe limit. Every probe spawns a child process (through `cmd.exe` on
 * Windows), so this is a load ceiling, not a measure of how slow any tool is.
 */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Must stay comfortably LONGER than the client's `qDoctor().staleTime`. When the
 * two were both 10s, every refetch-on-mount / refetch-on-focus landed just as
 * this cache expired, so opening the Dashboard re-paid the full ~3s sweep almost
 * every time — the cache existed but practically never hit.
 */
const DOCTOR_CACHE_TTL_MS = 60_000;

/**
 * Run all environment health checks concurrently. Cached briefly because the
 * full sweep spawns ~13 child processes; the dashboard refreshes often.
 */
export async function runDoctor(): Promise<DoctorReport> {
  const now = Date.now();
  if (lastReport && now - lastReport.at < DOCTOR_CACHE_TTL_MS) return lastReport.value;

  const k6Present = isToolFolderPresent('k6');
  const playwrightPresent = isToolFolderPresent('playwright');
  const robotPresent = isToolFolderPresent('robot-framework');

  const checks = await Promise.all([
    ...CHECKS.map(runCheck),
    checkK6(k6Present),
    checkPython(robotPresent),
    Promise.resolve(checkPlaywrightBrowsers(playwrightPresent)),
    checkDockerDaemon(),
    checkComposeService('influxdb', 8086),
    checkComposeService('grafana', 3000),
  ]);

  // Some checks may contribute an array; flatten so `DoctorReport.checks`
  // stays a flat list.
  const flatChecks: DoctorCheck[] = checks.flat();

  const overallOk = computeOverallOk(flatChecks);

  const value: DoctorReport = {
    checks: flatChecks,
    overallOk,
    credentialsOk: checkCredentials(),
  };
  lastReport = { value, at: now };
  return value;
}

/** Force the next /api/doctor call to re-probe. */
export function invalidateDoctorCache(): void {
  lastReport = null;
}
