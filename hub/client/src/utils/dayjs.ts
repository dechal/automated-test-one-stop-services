import dayjs from 'dayjs';
import 'dayjs/locale/th';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import relativeTime from 'dayjs/plugin/relativeTime';
import { type Locale, useI18nStore } from '~/i18n/index.js';

/**
 * Centralised dayjs plugin registration.
 *
 * Importing this module from `main.tsx` extends dayjs once so every component
 * can use `dayjs(...).fromNow()` and custom format parsing without each file
 * re-running `dayjs.extend(...)`.
 */
dayjs.extend(relativeTime);
dayjs.extend(customParseFormat);

export function setDayjsLocale(locale: Locale): void {
  dayjs.locale(locale);
}

setDayjsLocale(useI18nStore.getState().locale);
useI18nStore.subscribe((s) => setDayjsLocale(s.locale));

export { dayjs };
