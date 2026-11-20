export const REPORT_NAME_TOKENS = ['%d', '%m', '%y', '%Y', '%H', '%M', '%S'] as const;

export const REPORT_NAME_MAX_LENGTH = 200;

const FORBIDDEN_CHARS = /[<>:"/\\|?*]/;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const FIRST_PRINTABLE_CHAR_CODE = 32;

export type ReportNameError =
  | 'empty'
  | 'tooLong'
  | 'forbiddenChar'
  | 'controlChar'
  | 'reserved'
  | 'trailingDotOrSpace';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function renderReportName(template: string, date: Date): string {
  const values: Record<(typeof REPORT_NAME_TOKENS)[number], string> = {
    '%d': pad2(date.getDate()),
    '%m': pad2(date.getMonth() + 1),
    '%y': pad2(date.getFullYear() % 100),
    '%Y': String(date.getFullYear()),
    '%H': pad2(date.getHours()),
    '%M': pad2(date.getMinutes()),
    '%S': pad2(date.getSeconds()),
  };
  return template.replace(/%[dmyYHMS]/g, (token) => values[token as keyof typeof values]);
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
