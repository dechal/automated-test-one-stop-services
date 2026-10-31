// @ts-check
/**
 * Integration test for clean-container Setup_Bootstrap + Release_Launcher.
 *
 * Covers the bootstrap contract — Core tool installs, dependency install, Hub
 * start, idempotent re-runs, network-retry and privilege behaviour — plus the
 * launcher contract: no-arg start, Target_Directory prompt, Hub readiness poll.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY a full clean-container run is OUT OF SCOPE here
 * ─────────────────────────────────────────────────────────────────────────
 * The bootstrap is a *destructive* clean-machine flow: install node, pnpm,
 * uv and task (the 4 Core tools — k6 is no longer Core) user-scope,
 * then install workspace + Python deps, then start the Hub. Exercising that for real
 * requires (a) a throwaway container/VM (no Docker is available in this test
 * runner) and (b) live network downloads that would mutate the host. Both are
 * infeasible and unsafe in this environment. This suite therefore
 * splits coverage two ways:
 *
 *   • EXECUTION-verified — logic that CAN run safely here, with zero installs
 *     and zero network:
 *       - idempotency + step ordering, by driving the
 *         canonical ledger engine `scripts/setup/setup-state.mjs` (the SAME
 *         read/write engine both bootstrap scripts shell out to). We write a
 *         partial ledger, read it back, and assert only-remaining-steps
 *         semantics and that STEP_ORDER is exactly
 *         node,pnpm,uv,task,install-deps,start-hub (start-hub last, so
 *         verify can only run after every step).
 *
 *   • STRUCTURALLY-verified — clean-container behaviour that cannot execute
 *     without real installs, asserted by grepping the REAL script content of
 *     BOTH `setup-linux.sh` and `setup-windows.bat` (and both launchers).
 *     These are content/ordering contracts, not behavioural runs:
 *       - install the 4 Core tools; deps (pnpm install + uv sync); start Hub;
 *         strict SKIP when already on PATH; the verify block sits AFTER the
 *         final step.
 *       - network retry ≤3 @ 30s timeout; after retries → no Hub, re-runnable;
 *         user-scope install; privilege handling.
 *       - launcher contract — argv[1] target stays OPTIONAL, exactly one
 *         Target_Directory prompt, `mkdir -p` creates parents, "." default,
 *         clone then invoke setup-linux.sh.
 *       - launcher polls Hub readiness up to 60s then shows the URL.
 *       - Windows double-click (no arg) — static check on the .bat.
 *
 * Paths are computed from `__dirname` (not cwd) per the test-suite-location
 * convention, so the suite passes regardless of where `node --test` runs.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
// Static import of the canonical ledger engine (resolved relative to THIS file,
// so it works regardless of cwd). Its exported STEP_ORDER is the single source
// of truth both bootstrap scripts shell out to — see the cross-check below.
import { STEP_ORDER as ENGINE_STEP_ORDER } from '../setup/setup-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// `scripts/__tests__/<file>.spec.mjs` → repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SETUP_DIR = path.join(REPO_ROOT, 'scripts', 'setup');
const LAUNCHER_SH = path.join(
  SETUP_DIR,
  'automated-test-one-stop-service_installer_mac-and-linux.sh',
);
const LAUNCHER_BAT = path.join(SETUP_DIR, 'automated-test-one-stop-service_installer_windows.bat');
const BOOTSTRAP_SH = path.join(SETUP_DIR, 'setup-linux.sh');
const BOOTSTRAP_BAT = path.join(SETUP_DIR, 'setup-windows.bat');
const STATE_HELPER_MJS = path.join(SETUP_DIR, 'setup-state.mjs');

/** The canonical, ordered Setup_Bootstrap steps (tools → deps → Hub).
 *  start-hub MUST be last so verify can only run after all steps.
 *  k6 was removed from Core (provisioned by the k6 tool's own setup task),
 *  leaving 4 Core tools + deps + Hub = 6 steps. The Hub runs as a daemonless
 *  background process (optionally OS-supervised), so no process manager is a
 *  Core step. */
const EXPECTED_STEP_ORDER = ['node', 'pnpm', 'uv', 'task', 'install-deps', 'start-hub'];

/** Count non-overlapping occurrences of a literal substring. */
const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

// ===========================================================================
//  Ledger driver — drives the REAL scripts/setup/setup-state.mjs engine
// ===========================================================================

/** Run `setup-state.mjs <mode> <stateFile> [pairs...]` directly (no shell pipe,
 *  so the Git-Bash tty wrapper never contaminates stdout). */
function runStateHelper(mode, stateFile, pairs = []) {
  const res = spawnSync('node', [STATE_HELPER_MJS, mode, stateFile, ...pairs], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', error: res.error };
}

/** Parse `read` output ("<step>:<status>" per line) into an ordered list of
 *  {name, status}, ignoring any stray non-matching lines. */
function parseLedger(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^([a-z0-9-]+):(pending|done|failed)$/))
    .filter((m) => m !== null)
    .map((m) => ({ name: m[1], status: m[2] }));
}

// ===========================================================================
//  Group 1 (EXECUTION) — ledger idempotency + step ordering via setup-state.mjs
// ===========================================================================
describe('Setup_State ledger idempotency (execution-verified)', () => {
  /** @type {string[]} */
  const tmpDirs = [];
  const newStateFile = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-state-'));
    tmpDirs.push(dir);
    return path.join(dir, 'setup-state.json');
  };

  before(() => {
    assert.ok(fs.existsSync(STATE_HELPER_MJS), `missing ledger engine: ${STATE_HELPER_MJS}`);
    const probe = spawnSync('node', ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' });
    assert.equal(probe.stdout, 'ok', 'node is required to drive the ledger engine');
  });

  after(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('read emits every step in STEP_ORDER with start-hub LAST', () => {
    // Fresh (no file) read must still enumerate all 7 steps in canonical order,
    // defaulting to "pending". The order is the contract progress + verify rely
    // on; start-hub being last means verify can only run after every step.
    const stateFile = newStateFile();
    const { code, stdout, stderr } = runStateHelper('read', stateFile);
    assert.equal(code, 0, `read should exit 0\n${stderr}`);

    const ledger = parseLedger(stdout);
    assert.deepEqual(
      ledger.map((s) => s.name),
      EXPECTED_STEP_ORDER,
      'STEP_ORDER must be node,pnpm,uv,task,install-deps,start-hub',
    );
    assert.equal(ledger.at(-1)?.name, 'start-hub', 'start-hub must be the final step');
    assert.ok(
      ledger.every((s) => s.status === 'pending'),
      'a missing ledger must default every step to pending',
    );
  });

  it('a partial ledger plans ONLY the not-done steps (idempotency)', () => {
    // Simulate a re-run after a partial install: the first three tools are done.
    const stateFile = newStateFile();
    const w = runStateHelper('write', stateFile, ['node=done', 'pnpm=done', 'uv=done']);
    assert.equal(w.code, 0, `write should exit 0\n${w.stderr}`);

    const ledger = parseLedger(runStateHelper('read', stateFile).stdout);
    const byName = Object.fromEntries(ledger.map((s) => [s.name, s.status]));
    assert.equal(byName.node, 'done');
    assert.equal(byName.pnpm, 'done');
    assert.equal(byName.uv, 'done');

    // "planNextSteps" semantics: re-run performs only the steps that are NOT done.
    const remaining = ledger.filter((s) => s.status !== 'done').map((s) => s.name);
    assert.deepEqual(
      remaining,
      ['task', 'install-deps', 'start-hub'],
      'a re-run must skip done steps and plan only the remaining ones',
    );
  });

  it('write MERGES onto prior state — done steps are preserved across runs', () => {
    // Each write call persists one more step; earlier done steps must survive,
    // proving the ledger is the durable, re-runnable record.4 depends on.
    const stateFile = newStateFile();
    runStateHelper('write', stateFile, ['node=done']);
    runStateHelper('write', stateFile, ['pnpm=done']);
    runStateHelper('write', stateFile, ['uv=done', 'task=done']);

    const byName = Object.fromEntries(
      parseLedger(runStateHelper('read', stateFile).stdout).map((s) => [s.name, s.status]),
    );
    assert.equal(byName.node, 'done', 'earlier done step must be preserved across writes');
    assert.equal(byName.pnpm, 'done');
    assert.equal(byName.uv, 'done');
    assert.equal(byName.task, 'done');
    // Untouched steps remain plannable.
    assert.equal(byName['start-hub'], 'pending');
  });

  it('a "failed" step stays NOT-done so a re-run retries it (re-runnable partial state)', () => {
    // After exhausting network retries a step is recorded "failed". A re-run
    // must treat it as still-to-do (re-runnable), never as complete.
    const stateFile = newStateFile();
    runStateHelper('write', stateFile, ['node=done', 'pnpm=done', 'start-hub=failed']);

    const ledger = parseLedger(runStateHelper('read', stateFile).stdout);
    const start = ledger.find((s) => s.name === 'start-hub');
    assert.equal(start?.status, 'failed', 'a failed step must be persisted as failed');
    const remaining = ledger.filter((s) => s.status !== 'done').map((s) => s.name);
    assert.ok(remaining.includes('start-hub'), 'a failed step must be re-planned on re-run');
  });

  it('the canonical .mjs ledger engine exports the SAME STEP_ORDER (structural cross-check)', () => {
    // Single source of truth: both shell bootstraps shell out to
    // scripts/setup/setup-state.mjs, whose exported STEP_ORDER defines step
    // identity + order. (The former hub/server/src/services/setup-state.ts
    // cross-check was dropped — no such Hub service file exists; the engine's
    // own export is the authority the platform scripts actually use, a stronger
    // check than grepping a parallel source.)
    assert.deepEqual(
      ENGINE_STEP_ORDER,
      EXPECTED_STEP_ORDER,
      'setup-state.mjs STEP_ORDER must be node,pnpm,uv,task,install-deps,start-hub',
    );
  });
});

// ===========================================================================
//  Group 2 (STRUCTURAL) — Installer launcher contract (install.sh / install.bat)
// ===========================================================================
describe('Installer launcher contract (structural)', () => {
  /** @type {string} */ let launcherSrc;

  before(() => {
    assert.ok(fs.existsSync(LAUNCHER_SH), `missing launcher: ${LAUNCHER_SH}`);
    launcherSrc = fs.readFileSync(LAUNCHER_SH, 'utf8');
  });

  it('no CLI arg REQUIRED — the prompt runs when none is given', () => {
    // A target directory may be passed as argv[1] for an unattended install, but
    // it must stay optional: with no argument the launcher falls back to the
    // prompt, so a double-click still works with zero input.
    assert.match(
      launcherSrc,
      /TARGET="\$\{1:-\}"/,
      'launcher may accept an optional argv[1] target',
    );
    assert.match(
      launcherSrc,
      /if \[ -z "\$TARGET" \]; then\n\s+read -r -p "Enter Target Directory/,
      'the prompt must run when no argument was passed',
    );
    assert.ok(
      !/\$[2-9]/.test(launcherSrc),
      'launcher must not depend on any further positional params',
    );
  });

  it('asks for exactly ONE input — a single read prompt for Target Directory', () => {
    const readPrompts = (launcherSrc.match(/read\s+-r\s+-p\s+"Enter Target Directory/g) ?? [])
      .length;
    assert.equal(readPrompts, 1, 'launcher must prompt for the Target_Directory exactly once');
  });

  it('creates the Target Directory including parents when missing', () => {
    assert.match(launcherSrc, /mkdir -p "\$TARGET"/, 'launcher must mkdir -p the target');
  });

  it('defaults to the current directory when input is empty (no mandatory input)', () => {
    assert.match(launcherSrc, /TARGET="\."/, 'launcher must default TARGET to "." when empty');
  });

  it('clones the repo into the target then invokes setup-linux.sh', () => {
    assert.match(launcherSrc, /git clone/, 'launcher must clone the repo');
    assert.match(launcherSrc, /setup-linux\.sh/, 'launcher must invoke the bootstrap');
  });
});

// ===========================================================================
//  Group 3 (STRUCTURAL) — clean-container behaviour grepped from real scripts
// ===========================================================================
describe('Setup_Bootstrap clean-container contracts (structural)', () => {
  /** @type {string} */ let linux;
  /** @type {string} */ let win;
  /** @type {string} */ let launcherSh;
  /** @type {string} */ let launcherBat;

  before(() => {
    for (const f of [BOOTSTRAP_SH, BOOTSTRAP_BAT, LAUNCHER_SH, LAUNCHER_BAT]) {
      assert.ok(fs.existsSync(f), `missing script: ${f}`);
    }
    linux = fs.readFileSync(BOOTSTRAP_SH, 'utf8');
    win = fs.readFileSync(BOOTSTRAP_BAT, 'utf8');
    launcherSh = fs.readFileSync(LAUNCHER_SH, 'utf8');
    launcherBat = fs.readFileSync(LAUNCHER_BAT, 'utf8');
  });

  it('installs each of the 4 Core tools (both scripts)', () => {
    // Each Core tool has a numbered step header on both platforms (k6 removed from Core).
    for (const step of ['node \\(1/6\\)', 'pnpm \\(2/6\\)', 'uv \\(3/6\\)', 'task \\(4/6\\)']) {
      assert.match(linux, new RegExp(`\\[step\\] ${step}`), `linux missing step ${step}`);
      assert.match(win, new RegExp(`\\[step\\] ${step}`), `windows missing step ${step}`);
    }
    // Linux installers (volta/curl/brew).
    assert.match(linux, /volta install "node@/, 'linux must install node via volta');
    assert.match(linux, /volta install "pnpm@/, 'linux must install the pinned pnpm via volta');
    assert.match(linux, /astral\.sh\/uv\/install\.sh|brew_install uv/, 'linux must install uv');
    assert.match(
      linux,
      /taskfile\.dev\/install\.sh|brew_install go-task/,
      'linux must install task',
    );
    // Windows installers (scoop/volta).
    assert.match(win, /:installNode\b/, 'windows must install node');
    assert.match(win, /:installPnpm\b/, 'windows must install pnpm');
    assert.match(win, /:installUv\b/, 'windows must install uv');
    assert.match(win, /:installTask\b/, 'windows must install task');
    assert.match(win, /scoop install|volta install/, 'windows installs come from scoop/volta');
  });

  it('installs workspace + Python deps (pnpm install + uv sync) (both scripts)', () => {
    assert.match(linux, /\[step\] install-deps \(5\/6\)/, 'linux deps step');
    assert.match(linux, /pnpm -C "\$WORKSPACE_ROOT" install/, 'linux pnpm install');
    assert.match(linux, /uv sync/, 'linux uv sync');
    assert.match(win, /\[step\] install-deps \(5\/6\)/, 'windows deps step');
    assert.match(win, /pnpm -C "%WORKSPACE_ROOT%" install/, 'windows pnpm install');
    assert.match(win, /uv sync/, 'windows uv sync');
  });

  it('starts the Hub via the hub-service launcher (both scripts)', () => {
    // start-hub now delegates to hub/bin/hub-service.mjs, which runs the Hub as
    // a daemonless detached background process (no daemon of its own, so nothing
    // can be blocked by locked-down/corporate policy). The contract is
    // "start the Hub"; the launcher is the mechanism.
    assert.match(linux, /\[step\] start-hub \(6\/6\)/, 'linux start-hub step');
    assert.match(
      linux,
      /node "\$WORKSPACE_ROOT\/hub\/bin\/hub-service\.mjs" start/,
      'linux must start the Hub via the launcher',
    );
    assert.match(win, /\[step\] start-hub \(6\/6\)/, 'windows start-hub step');
    assert.match(
      win,
      /node "%WORKSPACE_ROOT%\\hub\\bin\\hub-service\.mjs" start/,
      'windows must start the Hub via the launcher',
    );
  });

  it('SKIPS a tool already on PATH — version-gated for node/pnpm (both scripts)', () => {
    // uv and task have no lockfile/runtime floor, so presence alone is enough:
    // one strict-skip branch each on both platforms.
    assert.ok(
      countOccurrences(linux, 'strict skip') >= 2,
      'linux must strict-skip uv and task when already present',
    );
    assert.ok(
      countOccurrences(win, 'strict skip') >= 2,
      'windows must strict-skip uv and task when already present',
    );
    // node and pnpm are skipped ONLY when the version on PATH clears the pinned
    // major. Presence alone used to be enough, which let an old node/pnpm through
    // and failed two steps later (pnpm lockfileVersion 9 / Hub build) with an
    // error that did not name the cause.
    assert.match(
      linux,
      /tool_major_ok node -v "\$NODE_MAJOR_MIN"/,
      'linux gates node on the pinned major',
    );
    assert.match(
      linux,
      /tool_major_ok pnpm -v "\$PNPM_MAJOR_MIN"/,
      'linux gates pnpm on the pinned major',
    );
    assert.match(
      win,
      /:toolMajorOk "node -v" %NODE_MAJOR_MIN%/,
      'windows gates node on the pinned major',
    );
    assert.match(
      win,
      /:toolMajorOk "pnpm -v" %PNPM_MAJOR_MIN%/,
      'windows gates pnpm on the pinned major',
    );
    // The floor is derived from versions.env, never hardcoded in the scripts.
    assert.match(
      linux,
      /NODE_MAJOR_MIN="\$\(major_of "\$NODE_VERSION"\)"/,
      'linux derives the node floor',
    );
    assert.match(
      win,
      /in \("%NODE_VERSION%"\) do set "NODE_MAJOR_MIN=/,
      'windows derives the node floor',
    );
    assert.match(
      linux,
      /command -v node &>\/dev\/null/,
      'linux detects an already-present tool via command -v',
    );
    assert.match(win, /where node >nul 2>nul/, 'windows detects an already-present tool via where');
  });

  it('the verify block runs only AFTER the final step (both scripts)', () => {
    const lxStart = linux.indexOf('[step] start-hub (6/6)');
    const lxVerify = linux.indexOf('[verify] Verifying all 4 Core tools');
    assert.ok(
      lxStart > 0 && lxVerify > 0,
      'linux must have both the start-hub step and verify block',
    );
    assert.ok(lxVerify > lxStart, 'linux verify must come after the start-hub step');

    const winStart = win.indexOf('[step] start-hub (6/6)');
    const winVerify = win.indexOf('[verify] Verifying all 4 Core tools');
    assert.ok(
      winStart > 0 && winVerify > 0,
      'windows must have both the start-hub step and verify block',
    );
    assert.ok(winVerify > winStart, 'windows verify must come after the start-hub step');
  });

  it('network downloads retry ≤3 with a 30s timeout (both scripts)', () => {
    // Linux: a retry helper invoked as `retry 3 30 ...` and a timeout cap inside it.
    assert.match(linux, /retry\(\)/, 'linux must define a retry helper');
    assert.match(linux, /retry 3 30 /, 'linux must retry network steps 3x with a 30s cap');
    assert.match(linux, /timeout "\$tmo"/, 'linux retry must apply the per-attempt timeout');
    // Windows: scoop/volta retry loops bounded at 3, curl prefetch capped at 30s.
    assert.match(win, /LSS 3/, 'windows install retries must be bounded at 3 attempts');
    assert.match(win, /--max-time 30/, 'windows network prefetch must cap at a 30s timeout');
  });

  it('after exhausted retries → no Hub start, state stays re-runnable (both scripts)', () => {
    // The fail path stops before the Hub and tells the user it is re-runnable;
    // completed steps are preserved (the ledger from Group 1).
    assert.match(
      linux,
      /Re-run to resume; completed steps are skipped/,
      'linux fail path must be re-runnable',
    );
    assert.match(linux, /fail_step\(\)/, 'linux must define fail_step that stops the run');
    assert.match(
      win,
      /Re-run to resume; completed steps are skipped/,
      'windows fail path must be re-runnable',
    );
    assert.match(win, /:fail\b/, 'windows must define a :fail routine that stops the run');
  });

  it('tools install user-scope where possible (both scripts)', () => {
    assert.match(linux, /user-scope/, 'linux must document/perform user-scope installs');
    assert.match(linux, /VOLTA_HOME|\.local\/bin/, 'linux user-scope shim dirs');
    assert.match(win, /user-scope/, 'windows must document/perform user-scope installs');
    assert.match(win, /scoop|VOLTA_BIN|\.local\\bin/, 'windows user-scope shim dirs');
  });

  it('privilege handling — no silent escalation; Windows still detects elevation', () => {
    // k6's apt path was the only former Core step that needed root; with k6 out
    // of Core every Core step on Linux is user-scope, so the bootstrap performs
    // NO privilege escalation (no sudo) and documents that installs need no root.
    assert.doesNotMatch(linux, /\bsudo\b/, 'linux Core flow must not silently escalate (no sudo)');
    assert.match(linux, /no root needed/, 'linux must document that Core installs need no root');
    // Windows scoop/volta are user-scope; the script still probes elevation so
    // privilege-sensitive sub-steps can choose user-scope vs report.
    assert.match(win, /net session/, 'windows must probe for elevation');
    assert.match(
      win,
      /IS_ADMIN/,
      'windows must record the elevation state for privilege decisions',
    );
  });

  it('launcher polls Hub readiness up to 60s then shows the URL (both launchers)', () => {
    // The polled URL and the URL shown on success come from one variable that
    // defaults to 5174, so a plain install still configures nothing while
    // `HUB_PORT=<port>` can move all of them together (they used to be three
    // separate hardcoded literals, which reported a false failure when the port
    // was overridden).
    // Linux launcher: a 60-iteration 1s poll, success prints the URL.
    assert.match(launcherSh, /up to 60s/, 'linux launcher documents the 60s readiness window');
    assert.match(launcherSh, /seq 1 60/, 'linux launcher polls 60 times (≈60s)');
    assert.match(launcherSh, /HUB_PORT:-5174/, 'linux launcher defaults the port to 5174');
    assert.match(launcherSh, /Open: \$HUB_URL/, 'linux launcher shows the URL on success');
    // Windows launcher: poll bounded at 60, success prints the URL.
    assert.match(launcherBat, /up to 60s/, 'windows launcher documents the 60s readiness window');
    assert.match(
      launcherBat,
      /_poll! GEQ 60|_poll GEQ 60/,
      'windows launcher bounds the poll at 60',
    );
    assert.match(
      launcherBat,
      /if not defined HUB_PORT set "HUB_PORT=5174"/,
      'windows launcher defaults the port to 5174',
    );
    assert.match(launcherBat, /Open: %HUB_URL%/, 'windows launcher shows the URL on success');
    // guard (not over-claimed): a 60s timeout must NOT present the URL as success.
    assert.match(launcherSh, /did not start within 60s/, 'linux launcher errors on timeout');
    assert.match(launcherBat, /did not start within 60s/, 'windows launcher errors on timeout');
  });

  it('Windows double-click needs no argument — single interactive prompt (static)', () => {
    // A headless double-click is impractical; assert the .bat reads one
    // Target_Directory input and that a CLI argument stays OPTIONAL: %~1 may
    // pre-fill the target for an unattended install, but with no argument the
    // prompt still runs, so a double-click needs zero input.
    assert.match(
      launcherBat,
      /set \/p "TARGET=/,
      'windows launcher must read the Target_Directory input',
    );
    assert.match(
      launcherBat,
      /if not defined TARGET set \/p "TARGET=/,
      'the prompt must run when no argument was passed',
    );
    assert.ok(
      !/%~?[2-9]\b/.test(launcherBat),
      'windows launcher must not depend on any further positional params',
    );
  });
});
