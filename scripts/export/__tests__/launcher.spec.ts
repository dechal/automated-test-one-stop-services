import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRunBat, type LauncherSpec } from '../launcher.js';

const echoSpec: LauncherSpec = {
  pathDirs: ['runtime\\k6'],
  env: { EXTRA_FLAG: '1' },
  tag: { kind: 'args', template: '-e "TAG=!TAG!"' },
  entry: { defaultPath: 'automations/specs/rest/e2e.spec.ts', overrideExtensions: ['.ts'] },
  command: [
    'echo REST=[!REST!]',
    'echo ENTRY=[!ENTRY!]',
    'echo TAG=[!TAG!]',
    'echo TAGARGS=[!TAGARGS!]',
    'echo HOME=[!B!]',
    'echo CWD=[!CD!]',
    'echo PATHV=[!PATH!]',
    'echo PYHOME=[!PYTHONHOME!]',
    'for %%E in (PLAIN QUOTED TRAIL EMPTY BLANK BANG PIPE URL SPACED SQEMPTY SQPATH SQINNER) do echo %%E=[!%%E!]',
    'cmd /c exit 3',
  ].join('&'),
  subcommands: [{ name: 'inspect', command: 'echo SUB=[!REST!] ENTRY=[!ENTRY!]&cmd /c exit 0' }],
};

describe('buildRunBat', () => {
  const text = buildRunBat(echoSpec);

  it('uses CRLF and starts with a quiet, local scope', () => {
    expect(text.startsWith('@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion')).toBe(
      true,
    );
    expect(text.split('\r\n').length).toBeGreaterThan(20);
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('puts only bundled dirs and the Windows dirs on PATH', () => {
    expect(text).toContain('set "PATH=%B%\\runtime\\k6;%SystemRoot%\\System32;%SystemRoot%"');
    expect(text).toContain('set "PYTHONHOME="');
    expect(text).toContain('set "PYTHONNOUSERSITE=1"');
    expect(text).toContain('set "EXTRA_FLAG=1"');
  });

  it('loads .env with a for /f loop and maps TAG per tool', () => {
    expect(text).toContain('for /f "usebackq eol=# tokens=1,* delims==" %%K in ("%B%\\.env")');
    expect(text).toContain('if defined TAG set TAGARGS=-e "TAG=!TAG!"');
    const envTag = buildRunBat({ ...echoSpec, tag: { kind: 'env', name: 'PLAYWRIGHT_GREP' } });
    expect(envTag).toContain('if defined TAG set "PLAYWRIGHT_GREP=!TAG!"');
  });

  it('rejects unsafe env names and subcommands', () => {
    expect(() => buildRunBat({ ...echoSpec, env: { 'A&B': '1' } })).toThrow();
    expect(() =>
      buildRunBat({ ...echoSpec, subcommands: [{ name: 'x&y', command: 'echo' }] }),
    ).toThrow();
  });
});

describe.runIf(process.platform === 'win32')('run.bat under a sanitised PATH', () => {
  let root: string;
  let bundle: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-launcher-'));
    bundle = path.join(root, 'moved copy', 'k6 bundle');
    fs.mkdirSync(path.join(bundle, 'runtime', 'k6'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'run.bat'), buildRunBat(echoSpec), 'utf8');
    fs.writeFileSync(
      path.join(bundle, '.env'),
      [
        '# comment line',
        'PLAIN=hello world',
        'QUOTED="a b # not a comment"',
        'TRAIL=value # trailing comment',
        'EMPTY=""',
        'BLANK=',
        'BANG=x!y',
        'PIPE="a|b"',
        'URL=http://h/x#frag',
        'SPACED=""       # inline note',
        "SQEMPTY=''          # default 10   (seconds)",
        "SQPATH='C:\\Program Files\\app\\x.exe'",
        "SQINNER='where a like '_x_%' and b in ('1')'",
        '',
      ].join('\n'),
      'utf8',
    );
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function run(args: string): { code: number | null; out: Record<string, string> } {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const res = spawnSync(
      path.join(systemRoot, 'System32', 'cmd.exe'),
      ['/d', '/s', '/c', `"run.bat ${args}"`],
      {
        cwd: bundle,
        encoding: 'utf8',
        windowsVerbatimArguments: true,
        env: {
          SystemRoot: systemRoot,
          PATH: `${systemRoot}\\System32;${systemRoot}`,
          PYTHONHOME: 'C:\\poison',
          TEMP: os.tmpdir(),
        },
      },
    );
    const out: Record<string, string> = {};
    for (const line of res.stdout.split(/\r?\n/)) {
      const m = line.match(/^([A-Z]+)=\[(.*?)\]\s*(?:ENTRY=\[(.*)\])?$/);
      if (m?.[1]) out[m[1]] = m[2] ?? '';
      if (m?.[3] !== undefined) out.SUBENTRY = m[3];
    }
    return { code: res.status, out };
  }

  it('loads .env values with quotes, comments and special characters', () => {
    const { out } = run('');
    expect(out).toMatchObject({
      PLAIN: 'hello world',
      QUOTED: 'a b # not a comment',
      TRAIL: 'value',
      EMPTY: '',
      BLANK: '',
      BANG: 'x!y',
      PIPE: 'a|b',
      URL: 'http://h/x#frag',
      SPACED: '',
      SQEMPTY: '',
      SQPATH: 'C:\\Program Files\\app\\x.exe',
      SQINNER: "where a like '_x_%' and b in ('1')",
    });
  });

  it('runs from its own folder with only bundled PATH entries and propagates the exit code', () => {
    const { code, out } = run('');
    expect(code).toBe(3);
    expect(out.HOME).toBe(bundle);
    expect(out.CWD).toBe(bundle);
    expect(out.PATHV?.startsWith(`${bundle}\\runtime\\k6;`)).toBe(true);
    expect(out.PYHOME).toBe('');
    expect(out.ENTRY).toBe('automations/specs/rest/e2e.spec.ts');
  });

  it('consumes TAG= and passes the remaining args through untouched', () => {
    const { out } = run('TAG=@smoke --vus 1 -e K=V "a|b"');
    expect(out.TAG).toBe('@smoke');
    expect(out.TAGARGS).toBe('-e "TAG=@smoke"');
    expect(out.REST?.trim()).toBe('--vus 1 -e K=V "a|b"');
  });

  it('accepts a quoted TAG regex', () => {
    const { out } = run('TAG="(?=.*@test)" --x');
    expect(out.TAG).toBe('(?=.*@test)');
    expect(out.REST?.trim()).toBe('--x');
  });

  it('overrides the entry with a spec path argument', () => {
    const { out } = run('automations\\specs\\soap\\e2e.spec.ts --vus 1');
    expect(out.ENTRY).toBe('automations\\specs\\soap\\e2e.spec.ts');
    expect(out.REST?.trim()).toBe('--vus 1');
  });

  it('dispatches a subcommand', () => {
    const { code, out } = run('inspect --verbose');
    expect(code).toBe(0);
    expect(out.SUB?.trim()).toBe('--verbose');
    expect(out.SUBENTRY).toBe('automations/specs/rest/e2e.spec.ts');
  });
});

describe('buildRunBat noArgsSubcommand', () => {
  it('jumps to the named subcommand when run with no arguments', () => {
    const text = buildRunBat({
      ...echoSpec,
      subcommands: [...echoSpec.subcommands, { name: 'runner', command: 'echo RUNNER' }],
      noArgsSubcommand: 'runner',
    });
    expect(text).toContain('if "%~1"=="" goto :sub_runner');
    expect(text).toContain(':sub_runner');
  });

  it('rejects a noArgsSubcommand that is not a subcommand', () => {
    expect(() => buildRunBat({ ...echoSpec, noArgsSubcommand: 'runner' })).toThrow();
  });
});
