export const REPORT_NAME_TOKENS = ['%d', '%m', '%y', '%Y', '%H', '%M', '%S'] as const;

export const REPORT_NAME_MAX_LENGTH = 200;
export const REPORT_DIR_MAX_LENGTH = 240;

const FORBIDDEN_CHARS = /[<>:"/\\|?*]/;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const FIRST_PRINTABLE_CHAR_CODE = 32;
const TOKEN_PATTERN = /%([dmyYHMS])(?:\{([^{}]*)\})?/g;
const DRIVE_ROOT = /^[A-Za-z]:[\\/]/;
const UNC_ROOT = /^\\\\[^\\/]+[\\/][^\\/]+/;
const POSIX_ROOT = /^\/(?!\/)/;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

export type ReportNameError =
  | 'empty'
  | 'tooLong'
  | 'forbiddenChar'
  | 'controlChar'
  | 'reserved'
  | 'trailingDotOrSpace'
  | 'badFormula';

export type ReportDirError = ReportNameError | 'notAbsolute';

type TokenLetter = 'd' | 'm' | 'y' | 'Y' | 'H' | 'M' | 'S';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function evaluateFormula(source: string): number | undefined {
  const tokens = source.match(/\d+|[-+*/()]|\S/g) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function primary(): number | undefined {
    const tok = next();
    if (tok === undefined) return undefined;
    if (/^\d+$/.test(tok)) return Number(tok);
    if (tok === '+' || tok === '-') {
      const value = primary();
      return value === undefined ? undefined : tok === '-' ? -value : value;
    }
    if (tok === '(') {
      const value = sum();
      return next() === ')' ? value : undefined;
    }
    return undefined;
  }

  function product(): number | undefined {
    let left = primary();
    while (left !== undefined && (peek() === '*' || peek() === '/')) {
      const op = next();
      const right = primary();
      if (right === undefined || (op === '/' && right === 0)) return undefined;
      left = op === '*' ? left * right : Math.trunc(left / right);
    }
    return left;
  }

  function sum(): number | undefined {
    let left = product();
    while (left !== undefined && (peek() === '+' || peek() === '-')) {
      const op = next();
      const right = product();
      if (right === undefined) return undefined;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  const result = sum();
  return result !== undefined && pos === tokens.length && Number.isSafeInteger(result)
    ? result
    : undefined;
}

function addMonthsClamped(date: Date, months: number): Date {
  const shifted = new Date(date);
  shifted.setDate(1);
  shifted.setMonth(shifted.getMonth() + months);
  const lastDay = new Date(shifted.getFullYear(), shifted.getMonth() + 1, 0).getDate();
  shifted.setDate(Math.min(date.getDate(), lastDay));
  return shifted;
}

function shiftDate(date: Date, letter: TokenLetter, amount: number): Date {
  switch (letter) {
    case 'd': {
      const shifted = new Date(date);
      shifted.setDate(shifted.getDate() + amount);
      return shifted;
    }
    case 'm':
      return addMonthsClamped(date, amount);
    case 'y':
    case 'Y':
      return addMonthsClamped(date, amount * 12);
    case 'H':
      return new Date(date.getTime() + amount * MS_PER_HOUR);
    case 'M':
      return new Date(date.getTime() + amount * MS_PER_MINUTE);
    case 'S':
      return new Date(date.getTime() + amount * MS_PER_SECOND);
  }
}

function formatToken(letter: TokenLetter, date: Date): string {
  switch (letter) {
    case 'd':
      return pad2(date.getDate());
    case 'm':
      return pad2(date.getMonth() + 1);
    case 'y':
      return pad2(date.getFullYear() % 100);
    case 'Y':
      return String(date.getFullYear());
    case 'H':
      return pad2(date.getHours());
    case 'M':
      return pad2(date.getMinutes());
    case 'S':
      return pad2(date.getSeconds());
  }
}

export function renderReportName(template: string, date: Date): string | undefined {
  let invalid = false;
  const rendered = template.replace(
    TOKEN_PATTERN,
    (_match, letter: TokenLetter, formula?: string) => {
      if (formula === undefined) return formatToken(letter, date);
      const amount = evaluateFormula(formula);
      if (amount === undefined) {
        invalid = true;
        return '';
      }
      return formatToken(letter, shiftDate(date, letter, amount));
    },
  );
  return invalid ? undefined : rendered;
}

export function validateReportName(name: string): ReportNameError | undefined {
  if (name.trim() === '') return 'empty';
  if (name.length > REPORT_NAME_MAX_LENGTH) return 'tooLong';
  if (FORBIDDEN_CHARS.test(name)) return 'forbiddenChar';
  if ([...name].some((ch) => ch.charCodeAt(0) < FIRST_PRINTABLE_CHAR_CODE)) return 'controlChar';
  if (RESERVED_NAMES.test(name)) return 'reserved';
  if (/[. ]$/.test(name)) return 'trailingDotOrSpace';
  return undefined;
}

export function reportNameError(template: string, date: Date): ReportNameError | undefined {
  const name = renderReportName(template, date);
  return name === undefined ? 'badFormula' : validateReportName(name);
}

export function validateReportDir(dir: string): ReportDirError | undefined {
  const trimmed = dir.replace(/[\\/]+$/, '');
  if (trimmed === '') return 'empty';
  if (trimmed.length > REPORT_DIR_MAX_LENGTH) return 'tooLong';
  const root =
    DRIVE_ROOT.exec(`${trimmed}\\`)?.[0] ??
    UNC_ROOT.exec(trimmed)?.[0] ??
    POSIX_ROOT.exec(trimmed)?.[0];
  if (root === undefined) return 'notAbsolute';
  const segments = trimmed
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean);
  for (const segment of segments) {
    const error = validateReportName(segment);
    if (error) return error;
  }
  return undefined;
}

export function reportDirError(template: string, date: Date): ReportDirError | undefined {
  const dir = renderReportName(template, date);
  return dir === undefined ? 'badFormula' : validateReportDir(dir);
}

export function cloneReportConfigError(
  config: { cloneReportName?: string; cloneReportDir?: string } | undefined,
  date: Date,
): { code: 'INVALID_REPORT_NAME' | 'INVALID_REPORT_DIR'; message: string } | undefined {
  const nameTemplate = config?.cloneReportName;
  const nameError = nameTemplate === undefined ? undefined : reportNameError(nameTemplate, date);
  if (nameError) return { code: 'INVALID_REPORT_NAME', message: nameError };
  const dirTemplate = config?.cloneReportDir;
  const dirError = dirTemplate === undefined ? undefined : reportDirError(dirTemplate, date);
  return dirError ? { code: 'INVALID_REPORT_DIR', message: dirError } : undefined;
}

export interface ReportDestination {
  id: string;
  name?: string;
  path: string;
  createdAt: string;
}

export function reportDirKey(dir: string): string {
  return dir
    .trim()
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}
