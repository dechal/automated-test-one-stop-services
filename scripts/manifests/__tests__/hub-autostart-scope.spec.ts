// scripts/manifests/__tests__/hub-autostart-scope.spec.ts
//
// Windows boot auto-start is user-scope (no admin) and needs no daemon:
//   - setup-windows.bat wires it via the launcher (`hub-service.mjs enable-boot`),
//     never a bare schtasks call.
//   - hub-service.mjs registers a logon Scheduled Task (`/sc onlogon /rl limited`,
//     never `/rl highest` or `runas`) whose action is hub-autostart.cmd.
//   - hub-autostart.cmd puts the Volta shim dir on PATH BEFORE invoking node, so
//     node resolves in the bare logon context, then runs the launcher `start`
//     (which runs the Hub as a daemonless background process).
//
// Validates: user-scope auto-start (no elevation).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const WIN_SCRIPT = path.join(REPO_ROOT, 'scripts', 'setup', 'setup-windows.bat');
const LAUNCHER = path.join(REPO_ROOT, 'hub', 'bin', 'hub-service.mjs');
const AUTOSTART_CMD = path.join(REPO_ROOT, 'hub', 'bin', 'hub-autostart.cmd');

const HUB_PRESENT = fs.existsSync(LAUNCHER) && fs.existsSync(AUTOSTART_CMD);

const WIN = fs.readFileSync(WIN_SCRIPT, 'utf8');
const LAUNCHER_SRC = HUB_PRESENT ? fs.readFileSync(LAUNCHER, 'utf8') : '';
const AUTOSTART = HUB_PRESENT ? fs.readFileSync(AUTOSTART_CMD, 'utf8') : '';
const VOLTA_SHIM = String.raw`scoop\apps\volta\current\appdata\bin`;

describe('Windows boot auto-start is wired via the launcher (user-scope, no admin)', () => {
  it('setup-windows.bat registers auto-start through hub-service.mjs enable-boot', () => {
    expect(WIN).toMatch(/hub-service\.mjs"\s+enable-boot/);
  });
});

describe.skipIf(!HUB_PRESENT)(
  'hub-service.mjs enable-boot registers a user-scope logon task (no admin)',
  () => {
    it('creates a logon Scheduled Task', () => {
      expect(LAUNCHER_SRC).toMatch(/schtasks\s+\/create/i);
      expect(LAUNCHER_SRC).toMatch(/\/sc\s+onlogon/i);
    });

    it('uses /rl limited (user scope) and never elevates', () => {
      expect(LAUNCHER_SRC).toMatch(/\/rl\s+limited/i);
      expect(LAUNCHER_SRC).not.toMatch(/\/rl\s+highest/i);
      expect(LAUNCHER_SRC).not.toMatch(/\brunas\b/i);
    });

    it('points the task at the hub-autostart.cmd wrapper', () => {
      expect(LAUNCHER_SRC).toMatch(/hub-autostart\.cmd/);
      expect(fs.existsSync(AUTOSTART_CMD)).toBe(true);
    });
  },
);

describe.skipIf(!HUB_PRESENT)('hub-autostart.cmd readies PATH before invoking node', () => {
  it('puts the Volta shim dir on PATH BEFORE it runs node', () => {
    const lines = AUTOSTART.split(/\r?\n/);
    const isComment = (l: string) => /^\s*REM\b/i.test(l);
    const pathLine = lines.findIndex(
      (l) => !isComment(l) && /set\s+"PATH=/i.test(l) && l.includes(VOLTA_SHIM),
    );
    const nodeLine = lines.findIndex((l) => !isComment(l) && /^\s*node\b/i.test(l));
    expect(pathLine).toBeGreaterThanOrEqual(0);
    expect(nodeLine).toBeGreaterThanOrEqual(0);
    expect(pathLine).toBeLessThan(nodeLine);
  });

  it('invokes the shared launcher start (the daemonless fallback lives there)', () => {
    expect(AUTOSTART).toMatch(/hub-service\.mjs"\s+start/);
  });
});
