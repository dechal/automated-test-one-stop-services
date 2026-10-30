#!/usr/bin/env node
// ============================================================================
// uninstall.mjs — undo what the one-click installer changed on THIS machine.
// ----------------------------------------------------------------------------
// Scope: only the things setup created. It never removes shared toolchains
// (volta / scoop / uv / task / node / pnpm) because other projects on the
// machine may depend on them, and by default it never deletes the workspace
// folder because that holds the user's own test projects. Both are listed as
// "kept" instead, so there is no doubt about what is left behind.
//
// SAFE BY DEFAULT (same convention as scripts/release.mjs):
//   no flags   → DRY RUN: prints the plan, changes nothing
//   --run      → actually remove (asks for confirmation once)
//   --yes      → skip the confirmation (for scripted/unattended removal)
//   --purge    → ALSO delete the workspace folder itself (see the gates below)
//
// Usage:
//   node scripts/setup/uninstall.mjs                     # show the plan
//   node scripts/setup/uninstall.mjs --run               # remove, with a confirm prompt
//   node scripts/setup/uninstall.mjs --run --yes
//   node scripts/setup/uninstall.mjs --purge             # show the plan incl. the folder
//   node scripts/setup/uninstall.mjs --purge --run       # remove everything (typed confirm)
//
// --purge is irreversible, so it is GATED. The gates are NOT bypassable — not by
// --yes, not by a TTY-less run — because every test project and the brain vault is
// its own git repo, and deleting the folder with work still inside it destroys that
// work permanently. Purge refuses while any of these is true:
//   1. a user test project exists under tools/<tool>/projects/<type>/ (the
//      *-template-example scaffolds that ship with the repo do not count)
//   2. a project knowledge folder exists under brain/projects/ (other than
//      the workspace's own `_workspace`)
//   3. any repo (root, brain, or a project under tools/) has uncommitted changes
//      or commits that are on no remote
// Only then does it ask for the folder NAME to be typed out — a y/N keypress is too
// cheap for an action with no undo.
//
// Double-clickable wrappers for non-technical users (they are the reason a .bat is
// needed at all: cmd keeps the running batch file open, so it must relocate itself
// to TEMP before the workspace can be deleted):
//   scripts/setup/automated-test-one-stop-service_uninstaller_windows.bat
//   scripts/setup/automated-test-one-stop-service_uninstaller_mac-and-linux.sh
//
// Tunables (env): SETUP_STATE_DIR (where .setup-state.json lives),
// HUB_SHORTCUT_DIR (where the desktop shortcut was written).
// ============================================================================

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { listGitDirs } from '../lib/list-git-dirs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(HERE, '..', '..');
const HUB_SERVICE = path.join(WORKSPACE_ROOT, 'hub', 'bin', 'hub-service.mjs');
const STATE_FILE = path.join(
  process.env.SETUP_STATE_DIR || path.join(WORKSPACE_ROOT, '.cache', 'state'),
  '.setup-state.json',
);
const LEGACY_STATE_FILE = path.join(WORKSPACE_ROOT, '.setup-state.json');
const HUB_RUN_DIR = path.join(WORKSPACE_ROOT, 'hub', '.run');
const IS_WIN = process.platform === 'win32';

const DRY_RUN = !process.argv.includes('--run');
const ASSUME_YES = process.argv.includes('--yes');
const PURGE = process.argv.includes('--purge');

/** Projects that ship WITH the repo as scaffolding, so they are not user work. */
const TEMPLATE_MARKER = 'template-example';
/** The brain slug that belongs to the workspace itself, not to a user project. */
const WORKSPACE_BRAIN_SLUG = '_workspace';

/** Windows user-scope env vars setup persisted with setx. */
const WIN_USER_ENV_VARS = ['PLAYWRIGHT_BROWSERS_PATH', 'VOLTA_FEATURE_PNPM'];

/**
 * The managed block scripts/setup/windows/set-git-bash.sh appends to ~/.bashrc.
 * Matched by SHAPE, not by an exact name, so a block written by an older version
 * of that script is removed as well — the same rule the writer applies.
 */
const BASHRC_BLOCK =
  /^[ \t]*# >>> [A-Za-z0-9._-]*workspace begin >>>[\s\S]*?^[ \t]*# <<< [A-Za-z0-9._-]*workspace end <<<[ \t]*\r?\n?/gm;

const done = [];
const kept = [];
const failed = [];

/** Record an action: performed on --run, described on a dry run. */
function step(label, action) {
  if (DRY_RUN) {
    done.push(label);
    return;
  }
  try {
    const note = action();
    done.push(note ? `${label} — ${note}` : label);
  } catch (e) {
    failed.push(`${label} — ${e.message}`);
  }
}

/**
 * Is the Hub still answering on HUB_PORT? Delegates to `hub-service.mjs status`,
 * which exits 0 only while the port is listening — so "is it up" has one
 * definition shared with the start/stop scripts instead of a second port check
 * implemented here. A missing launcher counts as down (nothing to hold a file).
 */
function hubIsUp() {
  if (!fs.existsSync(HUB_SERVICE)) return false;
  const r = spawnSync(process.execPath, [HUB_SERVICE, 'status'], {
    stdio: 'pipe',
    timeout: 60_000,
    encoding: 'utf8',
  });
  return r.status === 0;
}

/** Run a hub-service verb. Never throws: uninstalling must not stall on it. */
function hubService(verb) {
  if (!fs.existsSync(HUB_SERVICE)) return 'launcher not present, skipped';
  const r = spawnSync(process.execPath, [HUB_SERVICE, verb], {
    stdio: 'pipe',
    timeout: 60_000,
    encoding: 'utf8',
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').pop() || '';
  return out.trim() || `exit ${r.status ?? '?'}`;
}

/** PowerShell one-liner (no shell, so only PowerShell quoting applies). */
function powershell(script, extraEnv = {}) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', script], {
    stdio: 'pipe',
    timeout: 30_000,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  });
  if (r.error) throw r.error;
  return (r.stdout || '').trim();
}

function readUserPath() {
  return powershell("[Environment]::GetEnvironmentVariable('PATH','User')");
}

/**
 * Drop the PATH entries setup appended: the user-scope bin dir it created for
 * gb.bat, and Git's bundled GNU tools dir added for cross-shell `task`.
 * Everything else in the user PATH is left untouched.
 */
function pathEntriesToDrop(userPath) {
  const userLocal = path.join(process.env.USERPROFILE || '', '.local', 'bin').toLowerCase();
  return userPath
    .split(';')
    .filter((e) => e.trim() !== '')
    .filter((e) => {
      const v = e.trim().replace(/\\+$/, '').toLowerCase();
      return v === userLocal || /\\git\\usr\\bin$/.test(v);
    });
}

/**
 * Remove the managed block(s) from ~/.bashrc, leaving the user's own lines alone.
 * Returns null when there was nothing to remove.
 */
function stripBashrcBlock(text) {
  const next = text.replace(BASHRC_BLOCK, '').replace(/\n{3,}/g, '\n\n');
  return next === text ? null : next;
}

function rmIfExists(target, { recursive = false } = {}) {
  if (!fs.existsSync(target)) return 'nothing to remove';
  fs.rmSync(target, { force: true, recursive });
  return 'removed';
}

// ── --purge gates ─────────────────────────────────────────────────────────────
// Every gate function takes the root to scan so `--selftest` can point them at a
// fixture instead of the real machine.

/** Sub-directories of `dir`; empty when it does not exist or cannot be read. */
function subDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * The user's own test projects: `tools/<tool>/projects/<type>/<project>`, minus the
 * `*-template-example` scaffolds the repo ships with. Tool-agnostic on purpose —
 * a new tool folder needs no edit here.
 */
function userProjects(root) {
  const found = [];
  for (const tool of subDirs(path.join(root, 'tools'))) {
    const projectsDir = path.join(root, 'tools', tool, 'projects');
    for (const type of subDirs(projectsDir)) {
      for (const project of subDirs(path.join(projectsDir, type))) {
        if (project.includes(TEMPLATE_MARKER)) continue;
        found.push(`tools/${tool}/projects/${type}/${project}`);
      }
    }
  }
  return found;
}

/**
 * Project knowledge folders under `brain/projects/`, excluding the workspace's own
 * `_workspace` notes and the shipped template — same rule as `userProjects`.
 */
function brainProjects(root) {
  return subDirs(path.join(root, 'brain', 'projects'))
    .filter((name) => name !== WORKSPACE_BRAIN_SLUG && !name.includes(TEMPLATE_MARKER))
    .map((name) => `brain/projects/${name}`);
}

/** Run git inside `repo`; '' on any failure (a broken repo blocks nothing). */
function git(repo, args) {
  const r = spawnSync('git', args, {
    cwd: repo,
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 30_000,
  });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

/**
 * Every git repo that would be destroyed with the folder: the root, the brain
 * vault, and each project repo under `tools/` (found with the same helper the
 * `pull` task uses). Scanning `tools/` rather than the whole tree keeps this off
 * `.cache/` and `outputs/`.
 */
function repoDirs(root) {
  const candidates = [
    root,
    path.join(root, 'brain'),
    ...listGitDirs(`${root.replace(/\\/g, '/')}/tools`).map((g) => path.dirname(g)),
  ];
  return [...new Set(candidates.map((p) => path.resolve(p)))].filter((p) =>
    fs.existsSync(path.join(p, '.git')),
  );
}

/**
 * Repos holding work that exists only on this machine. `status --porcelain` covers
 * staged + unstaged + untracked; `log --branches --not --remotes` covers commits on
 * no remote — which includes a repo with no remote configured at all, where every
 * commit is local-only. Both are exactly what a folder delete would take with it.
 */
function reposWithLocalWork(root) {
  const out = [];
  for (const repo of repoDirs(root)) {
    const dirty = git(repo, ['status', '--porcelain']) !== '';
    const unpushed = git(repo, ['log', '--branches', '--not', '--remotes', '--oneline']) !== '';
    if (!dirty && !unpushed) continue;
    const label = path.relative(root, repo).replace(/\\/g, '/') || '.';
    const why = [dirty && 'uncommitted changes', unpushed && 'commits on no remote']
      .filter(Boolean)
      .join(' + ');
    out.push(`${label} — ${why}`);
  }
  return out;
}

/** All reasons purge must refuse, as user-facing lines. Empty array = allowed. */
function purgeBlockers(root) {
  const blockers = [];
  const projects = userProjects(root);
  if (projects.length > 0) {
    blockers.push(`${projects.length} test project(s) still here: ${projects.join(', ')}`);
  }
  const brains = brainProjects(root);
  if (brains.length > 0) {
    blockers.push(`${brains.length} project knowledge folder(s) still here: ${brains.join(', ')}`);
  }
  for (const repo of reposWithLocalWork(root)) blockers.push(`unsaved work in ${repo}`);
  return blockers;
}

/**
 * Delete the workspace folder itself. `chdir` out of the tree first: the OS holds a
 * handle on the process's cwd, so a tree containing it cannot be removed on Windows.
 * This script file lives inside the tree too, which is fine (Node reads a module
 * fully and closes the fd). A file still locked by an editor or another node process
 * surfaces as a thrown error — never a silent half-deleted workspace.
 */
function purgeWorkspace() {
  process.chdir(os.tmpdir());
  fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
  if (fs.existsSync(WORKSPACE_ROOT)) {
    throw new Error(
      'some files are still locked — close editors/terminals open in the folder, then re-run',
    );
  }
  return 'removed';
}

function plan() {
  step('Stop the Hub', () => hubService('stop'));
  step('Remove the start-at-login registration', () => hubService('disable-boot'));
  step('Remove the "Test Hub" desktop shortcut', () => hubService('remove-shortcut'));
  step(`Remove the setup ledger (${STATE_FILE})`, () => rmIfExists(STATE_FILE));
  if (LEGACY_STATE_FILE !== STATE_FILE && fs.existsSync(LEGACY_STATE_FILE)) {
    step(`Remove the old root setup ledger (${LEGACY_STATE_FILE})`, () =>
      rmIfExists(LEGACY_STATE_FILE),
    );
  }
  step(`Remove the Hub run/pid/log dir (${HUB_RUN_DIR})`, () =>
    rmIfExists(HUB_RUN_DIR, { recursive: true }),
  );

  if (IS_WIN) {
    const gbShim = path.join(process.env.USERPROFILE || '', '.local', 'bin', 'gb.bat');
    step(`Remove the gb.bat shim (${gbShim})`, () => rmIfExists(gbShim));

    for (const name of WIN_USER_ENV_VARS) {
      step(`Clear the user environment variable ${name}`, () => {
        powershell(`[Environment]::SetEnvironmentVariable('${name}', $null, 'User')`);
        return 'cleared';
      });
    }

    step('Remove the PATH entries setup added (user scope)', () => {
      const userPath = readUserPath();
      const drop = pathEntriesToDrop(userPath);
      if (drop.length === 0) return 'none found';
      const next = userPath
        .split(';')
        .filter((e) => e.trim() !== '' && !drop.includes(e))
        .join(';');
      powershell(
        "[Environment]::SetEnvironmentVariable('PATH', $env:SETUP_NEW_USER_PATH, 'User')",
        {
          SETUP_NEW_USER_PATH: next,
        },
      );
      return `removed ${drop.map((d) => d.trim()).join(', ')}`;
    });

    const bashrc = path.join(process.env.USERPROFILE || '', '.bashrc');
    step(`Remove the managed Git Bash block from ${bashrc}`, () => {
      if (!fs.existsSync(bashrc)) return 'no .bashrc';
      const text = fs.readFileSync(bashrc, 'utf8');
      const stripped = stripBashrcBlock(text);
      if (stripped === null) return 'block not present';
      fs.writeFileSync(bashrc, stripped, 'utf8');
      return 'block removed';
    });
  }

  kept.push(
    'node / pnpm / uv / task and their managers (volta, scoop) — other projects may use them',
  );
  if (!PURGE) {
    kept.push(`the workspace folder itself (${WORKSPACE_ROOT}) — it holds your test projects`);
    kept.push(
      'downloaded browsers under .cache/playwright-browsers — delete that folder to reclaim the space',
    );
  }
  kept.push(
    'global git tweaks (core.fscache, core.preloadindex, gc.auto) — harmless, shared with other repos',
  );
}

function report() {
  const verb = DRY_RUN ? 'Would do' : 'Done';
  console.log('');
  console.log('===================================================');
  console.log(`  ${verb}:`);
  for (const line of done) console.log(`    - ${line}`);
  if (failed.length > 0) {
    console.log('');
    console.log('  Could not finish (safe to re-run):');
    for (const line of failed) console.log(`    ! ${line}`);
  }
  console.log('');
  console.log('  Left in place on purpose:');
  for (const line of kept) console.log(`    - ${line}`);
  console.log('===================================================');
  if (DRY_RUN) {
    console.log('  This was a dry run. Re-run with --run to apply it.');
  } else {
    console.log('  Open a new terminal for the PATH change to take effect.');
  }
  console.log('');
}

/** Ask once before changing anything. Requires --yes when there is no TTY. */
async function confirm() {
  if (ASSUME_YES) return true;
  if (!process.stdin.isTTY) {
    console.error('  Not a terminal — pass --yes to confirm a non-interactive removal.');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question('  Remove the items listed above? [y/N]: ', (a) => {
      rl.close();
      resolve(a.trim().toLowerCase());
    });
  });
  return answer === 'y' || answer === 'yes';
}

/**
 * Purge has no undo, so a keypress is not enough: the folder NAME must be typed.
 * `--yes` still skips it for unattended runs — but the gates above are checked
 * either way, so an unattended purge can only ever run on an already-empty workspace.
 */
async function confirmPurge() {
  const name = path.basename(WORKSPACE_ROOT);
  if (ASSUME_YES) return true;
  if (!process.stdin.isTTY) {
    console.error('  Not a terminal — pass --yes to confirm a non-interactive purge.');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question(`  Type the folder name to delete it permanently ("${name}"): `, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
  if (answer !== name) console.log('  Name did not match.');
  return answer === name;
}

/**
 * `--selftest` — assertions for the two functions that edit something the user
 * owns (their PATH, their ~/.bashrc). Runnable without touching the machine:
 *   node scripts/setup/uninstall.mjs --selftest
 */
async function selfTest() {
  const assert = (await import('node:assert/strict')).default;
  const savedProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = 'C:\\Users\\tester';

  const userPath = [
    'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps',
    'C:\\Users\\tester\\.local\\bin',
    'C:\\Program Files\\Git\\usr\\bin\\',
    'C:\\tools\\keep-me',
    'c:\\users\\tester\\.LOCAL\\Bin',
  ].join(';');
  const drop = pathEntriesToDrop(userPath).map((e) => e.trim());
  assert.deepEqual(drop, [
    'C:\\Users\\tester\\.local\\bin',
    'C:\\Program Files\\Git\\usr\\bin\\',
    'c:\\users\\tester\\.LOCAL\\Bin',
  ]);
  assert.equal(
    pathEntriesToDrop('C:\\tools\\keep-me;C:\\Windows').length,
    0,
    'keeps unrelated entries',
  );

  const managed = (name) =>
    `export FOO=1\n\n# >>> ${name}-workspace begin >>>\nexport PS1='x'\n# <<< ${name}-workspace end <<<\nexport BAR=2\n`;
  assert.equal(
    stripBashrcBlock(managed('autoqa')),
    'export FOO=1\n\nexport BAR=2\n',
    'strips the current managed block, keeps the user lines',
  );
  assert.equal(
    stripBashrcBlock(managed('some-older-name')),
    'export FOO=1\n\nexport BAR=2\n',
    'strips a block written by an older version of the writer',
  );
  assert.equal(stripBashrcBlock('export FOO=1\n'), null, 'no block → null');

  process.env.USERPROFILE = savedProfile;

  // Purge gates: a fixture tree, so the real machine is never touched.
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-selftest-'));
  try {
    const mk = (...segments) => fs.mkdirSync(path.join(fixture, ...segments), { recursive: true });
    mk('tools', 'playwright', 'projects', 'web', 'my-project');
    mk('tools', 'playwright', 'projects', 'web', 'playwright-web-template-example');
    mk('tools', 'k6', 'projects', 'performance', 'k6-performance-template-example');
    mk('brain', 'projects', '_workspace');
    mk('brain', 'projects', 'project-template-example');
    mk('brain', 'projects', 'my-project');

    assert.deepEqual(
      userProjects(fixture),
      ['tools/playwright/projects/web/my-project'],
      'counts the user project, ignores every *-template-example scaffold',
    );
    assert.deepEqual(
      brainProjects(fixture),
      ['brain/projects/my-project'],
      'keeps _workspace and the template out',
    );
    assert.ok(
      purgeBlockers(fixture).length >= 2,
      'a workspace with a project and a brain folder is refused',
    );

    fs.rmSync(path.join(fixture, 'tools', 'playwright', 'projects', 'web', 'my-project'), {
      recursive: true,
    });
    fs.rmSync(path.join(fixture, 'brain', 'projects', 'my-project'), { recursive: true });
    assert.deepEqual(userProjects(fixture), [], 'templates alone are not user work');
    assert.deepEqual(
      purgeBlockers(fixture),
      [],
      'a workspace with only templates and no git repo is allowed',
    );
    assert.deepEqual(
      userProjects(path.join(fixture, 'nope')),
      [],
      'missing tools/ is not an error',
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }

  console.log('  selftest: PATH filter + .bashrc block strip + purge gates OK');
  return 0;
}

async function main() {
  if (process.argv.includes('--selftest')) return selfTest();
  console.log('===================================================');
  console.log('  UNINSTALL — Automated Test One-Stop Service');
  console.log('===================================================');
  console.log(`  Workspace: ${WORKSPACE_ROOT}`);
  const mode = PURGE ? 'REMOVE + DELETE THE WORKSPACE FOLDER' : 'REMOVE';
  console.log(DRY_RUN ? `  Mode: DRY RUN of ${mode} (nothing will change)` : `  Mode: ${mode}`);

  // Gates run on a dry run too: the point is to show what must be cleared first.
  if (PURGE) {
    const blockers = purgeBlockers(WORKSPACE_ROOT);
    if (blockers.length > 0) {
      console.log('');
      console.log('  PURGE REFUSED — nothing was changed. Clear these first:');
      for (const line of blockers) console.log(`    ! ${line}`);
      console.log('');
      console.log('  Deleting the folder also deletes every git repo inside it, so push your');
      console.log('  work and remove your projects (Hub → Projects, or delete the folders)');
      console.log('  before purging. Plain uninstall without --purge works right now.');
      console.log('');
      return 2;
    }
  }

  if (!DRY_RUN) {
    console.log('');
    console.log('  About to remove:');
    for (const line of planPreview()) console.log(`    - ${line}`);
    const approved = PURGE ? await confirmPurge() : await confirm();
    if (!approved) {
      console.log('  Cancelled — nothing was changed.');
      return 0;
    }
  }

  plan();
  report();

  if (PURGE && DRY_RUN) {
    console.log(`  Then delete the workspace folder itself: ${WORKSPACE_ROOT}`);
    console.log('');
  } else if (PURGE) {
    // Stop-before-delete guard. `plan()` already ran `hub-service stop`, but if
    // that did not take (an OS supervisor restarted it, a policy blocked the
    // kill), the Hub still holds files under hub/ and its cwd inside the tree —
    // so the delete would fail halfway and leave a wrecked folder. Fail closed
    // instead: nothing is deleted while anything still answers on HUB_PORT.
    if (hubIsUp()) {
      console.error('  [error] The Hub is still running, so the folder was NOT deleted.');
      console.error(
        '  Stop it and re-run:  task hub-stop     (or: node hub/bin/hub-service.mjs stop)',
      );
      console.error(
        '  Still up after that? node hub/bin/hub-service.mjs status  shows what owns the port.',
      );
      console.error('');
      return 1;
    }
    try {
      purgeWorkspace();
      console.log(`  Deleted the workspace folder: ${WORKSPACE_ROOT}`);
      console.log('');
    } catch (e) {
      console.error(`  [error] Could not delete the workspace folder — ${e.message}`);
      console.error('');
      return 1;
    }
  }

  return failed.length > 0 ? 1 : 0;
}

/** The same list `plan()` acts on, as plain text for the confirmation prompt. */
function planPreview() {
  const items = [
    'stop the Hub and remove its start-at-login registration',
    'remove the "Test Hub" desktop shortcut',
    'remove the setup ledger and the Hub run/log folder',
  ];
  if (IS_WIN) {
    items.push('remove the gb.bat shim and the PATH entries setup added');
    items.push(`clear the user environment variables: ${WIN_USER_ENV_VARS.join(', ')}`);
    items.push('remove the managed Git Bash block from ~/.bashrc');
  }
  if (PURGE) {
    items.push('verify the Hub is really down — the folder is not deleted while it answers');
  }
  items.push(
    PURGE
      ? `DELETE THE WHOLE WORKSPACE FOLDER (${WORKSPACE_ROOT}) — irreversible; KEEP node/pnpm/uv/task, volta/scoop`
      : 'KEEP node/pnpm/uv/task, volta/scoop, and the workspace folder',
  );
  return items;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`  [error] ${e.message}`);
    process.exit(1);
  });
