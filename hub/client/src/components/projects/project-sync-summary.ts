import type { TranslationKey } from '~/i18n/index.js';

export type ProjectSyncStatus = 'synced' | 'already-up-to-date' | 'diverged' | 'failed';

export interface ProjectSyncResult {
  repo: string;
  status: ProjectSyncStatus;
  message: string;
}

const STATUS_ORDER: readonly ProjectSyncStatus[] = [
  'synced',
  'already-up-to-date',
  'diverged',
  'failed',
];
const OK_STATUSES: readonly ProjectSyncStatus[] = ['synced', 'already-up-to-date'];
const MAX_NAMED_REPOS = 3;

export interface ProjectSyncSummary {
  ok: boolean;
  message: string;
}

export function summarizeProjectSync(
  results: readonly ProjectSyncResult[],
  t: (key: TranslationKey) => string,
): ProjectSyncSummary {
  const counts = STATUS_ORDER.flatMap((status) => {
    const n = results.filter((r) => r.status === status).length;
    return n > 0 ? [`${n} ${t(`projects.projectSyncStatus.${status}`)}`] : [];
  }).join(', ');
  const bad = results.filter((r) => !OK_STATUSES.includes(r.status)).map((r) => r.repo);
  if (bad.length === 0) return { ok: true, message: counts };
  const named = bad.slice(0, MAX_NAMED_REPOS).join(', ');
  const extra = bad.length > MAX_NAMED_REPOS ? ` +${bad.length - MAX_NAMED_REPOS}` : '';
  return { ok: false, message: `${counts}: ${named}${extra}` };
}
