export const LAUNCHER_FILE = 'run.bat';

export type LauncherTag =
  | { readonly kind: 'env'; readonly name: string }
  | { readonly kind: 'args'; readonly template: string };

export interface LauncherSubcommand {
  readonly name: string;
  readonly command: string;
}

export interface LauncherEntry {
  readonly defaultPath: string;
  readonly overrideExtensions: readonly string[];
}

export interface LauncherSpec {
  readonly pathDirs: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly tag: LauncherTag;
  readonly entry?: LauncherEntry;
  readonly command: string;
  readonly subcommands: readonly LauncherSubcommand[];
  readonly noArgsSubcommand?: string;
}

const BASE_ENV: Readonly<Record<string, string>> = {
  PYTHONHOME: '',
  PYTHONPATH: '',
  PYTHONNOUSERSITE: '1',
  PYTHONUTF8: '1',
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
};

const STRLEN_POWERS = '4096 2048 1024 512 256 128 64 32 16 8 4 2 1';

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_SUBCOMMAND = /^[a-z][a-z0-9-]*$/;

function strlenLines(): string[] {
  return [
    'set "_N=0"',
    `for %%P in (${STRLEN_POWERS}) do if not "!_S:~%%P,1!"=="" (`,
    '  set /a "_N+=%%P"',
    '  set "_S=!_S:~%%P!"',
    ')',
  ];
}

function setLine(name: string, value: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`unsafe env name for run.bat: ${name}`);
  return `set "${name}=${value}"`;
}

function tagLine(tag: LauncherTag): string {
  if (tag.kind === 'env') {
    if (!SAFE_NAME.test(tag.name)) throw new Error(`unsafe tag env name: ${tag.name}`);
    return `if defined TAG set "${tag.name}=!TAG!"`;
  }
  return `if defined TAG set TAGARGS=${tag.template}`;
}

export function buildRunBat(spec: LauncherSpec): string {
  for (const sub of spec.subcommands) {
    if (!SAFE_SUBCOMMAND.test(sub.name)) throw new Error(`unsafe subcommand: ${sub.name}`);
  }
  const noArgs = spec.noArgsSubcommand;
  if (noArgs !== undefined && !spec.subcommands.some((sub) => sub.name === noArgs)) {
    throw new Error(`noArgsSubcommand is not a subcommand: ${noArgs}`);
  }
  const pathValue = [
    ...spec.pathDirs.map((d) => `%B%\\${d}`),
    '%SystemRoot%\\System32',
    '%SystemRoot%',
  ];
  const env = { ...BASE_ENV, ...spec.env };
  const lines: string[] = [
    '@echo off',
    'setlocal EnableExtensions DisableDelayedExpansion',
    'set "B=%~dp0"',
    'if "%B:~-1%"=="\\" set "B=%B:~0,-1%"',
    setLine('PATH', pathValue.join(';')),
    ...Object.entries(env).map(([k, v]) => setLine(k, v)),
    'if exist "%B%\\.env" for /f "usebackq eol=# tokens=1,* delims==" %%K in ("%B%\\.env") do (',
    '  set "_K=%%K"',
    '  set "_V=%%L"',
    '  call :env_line',
    ')',
    'set "_K="',
    'set "_V="',
    'cd /d "%B%"',
    'set ARGS= %*',
    'set "SKIP=0"',
    'set "TAG="',
    'set "TAGARGS="',
    setLine('ENTRY', spec.entry?.defaultPath ?? ''),
    ...(noArgs === undefined ? [] : [`if "%~1"=="" goto :sub_${noArgs}`]),
    ...spec.subcommands.map((sub) => `if /i "%~1"=="${sub.name}" goto :sub_${sub.name}`),
    'if /i not "%~1"=="TAG" goto :entry',
    'set "TAG=%~2"',
    'set _RAW=%1',
    'call :skip_len',
    'set _RAW=%2',
    'call :skip_len',
    'shift',
    'shift',
    ':entry',
  ];
  if (spec.entry && spec.entry.overrideExtensions.length > 0) {
    const checks = spec.entry.overrideExtensions.map(
      (ext) => `if /i "%~x1"=="${ext}" goto :entry_set`,
    );
    lines.push(
      ...checks,
      'goto :run',
      ':entry_set',
      'set "ENTRY=%~1"',
      'set _RAW=%1',
      'call :skip_len',
    );
  }
  lines.push(
    ':run',
    'setlocal EnableDelayedExpansion',
    tagLine(spec.tag),
    'set "REST=!ARGS:~%SKIP%!"',
    spec.command,
    'exit /b %ERRORLEVEL%',
  );
  for (const sub of spec.subcommands) {
    lines.push(
      `:sub_${sub.name}`,
      'set _RAW=%1',
      'call :skip_len',
      'setlocal EnableDelayedExpansion',
      'set "REST=!ARGS:~%SKIP%!"',
      sub.command,
      'exit /b %ERRORLEVEL%',
    );
  }
  lines.push(
    ':skip_len',
    'setlocal EnableDelayedExpansion',
    'set "_S=!_RAW!#"',
    ...strlenLines(),
    'set /a "_N+=1"',
    'endlocal & set /a "SKIP+=%_N%"',
    'goto :eof',
    ':env_line',
    'setlocal EnableDelayedExpansion',
    'set "_K=!_K: =!"',
    'if not defined _K (',
    '  endlocal',
    '  goto :eof',
    ')',
    'set "_DQ=""',
    ':env_lead',
    'if not defined _V goto :env_store',
    'if "!_V:~0,1!"==" " (',
    '  set "_V=!_V:~1!"',
    '  goto :env_lead',
    ')',
    'if "!_V:~0,1!"=="!_DQ!" goto :env_quoted',
    `if "!_V:~0,1!"=="'" goto :env_squoted`,
    'set "_C=!_V:* #=!"',
    'if "!_C!"=="!_V!" goto :env_trail',
    'set "_S=!_C!#"',
    ...strlenLines(),
    'set /a "_N+=2"',
    'for %%N in (!_N!) do set "_V=!_V:~0,-%%N!"',
    ':env_trail',
    'if not defined _V goto :env_store',
    'if "!_V:~-1!"==" " (',
    '  set "_V=!_V:~0,-1!"',
    '  goto :env_trail',
    ')',
    'goto :env_store',
    ':env_squoted',
    'set "_V=!_V:~1!"',
    'set "_C=!_V:* #=!"',
    'if "!_C!"=="!_V!" goto :env_sq_trail',
    'set "_S=!_C!#"',
    ...strlenLines(),
    'set /a "_N+=2"',
    'for %%N in (!_N!) do set "_V=!_V:~0,-%%N!"',
    ':env_sq_trail',
    'if not defined _V goto :env_store',
    'if "!_V:~-1!"==" " (',
    '  set "_V=!_V:~0,-1!"',
    '  goto :env_sq_trail',
    ')',
    `if "!_V:~-1!"=="'" set "_V=!_V:~0,-1!"`,
    'goto :env_store',
    ':env_quoted',
    'set "_V=!_V:~1!"',
    'set "_C=!_V:*"=!"',
    'if "!_C!"=="!_V!" goto :env_store',
    'set "_S=!_C!#"',
    ...strlenLines(),
    'set /a "_N+=1"',
    'for %%N in (!_N!) do set "_V=!_V:~0,-%%N!"',
    ':env_store',
    'for /f "eol=| delims=" %%R in ("!_V!") do (',
    '  endlocal',
    '  set "%_K%=%%R"',
    '  goto :eof',
    ')',
    'endlocal & set "%_K%="',
    'goto :eof',
    '',
  );
  return lines.join('\r\n');
}
