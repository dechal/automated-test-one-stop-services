import { CronExpressionParser } from 'cron-parser';
import cronstrue from 'cronstrue';
import 'cronstrue/locales/th';
import type { Locale } from '~/i18n/index.js';
import { formatRelative, formatShort } from '~/utils/datetime.js';

export function humanizeCron(expr: string, locale: Locale): string | null {
  try {
    return cronstrue.toString(expr, { locale, use24HourTimeFormat: true });
  } catch {
    return null;
  }
}

export function formatNextRun(expr: string): string | null {
  try {
    const iso = CronExpressionParser.parse(expr).next().toDate().toISOString();
    return `${formatRelative(iso)} (${formatShort(iso)})`;
  } catch {
    return null;
  }
}
