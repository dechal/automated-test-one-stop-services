import type { RunRecord } from '@hub/shared';
import dayjs from 'dayjs';
import { formatDurationBetween } from '~/utils/datetime.js';

export function exportHistoryCsv(sorted: RunRecord[]): void {
  const rows = sorted.map((r) => ({
    id: r.id,
    tool: r.request.tool,
    type: r.request.type,
    project: r.request.project,
    status: r.status,
    mode: r.request.mode,
    triggeredBy: r.triggeredBy ?? 'manual',
    environment: r.environment ?? '',
    envProfileName: r.envProfileName ?? '',
    tag: r.request.tag ?? '',
    cases: r.summary ? r.summary.passed + r.summary.failed + (r.summary.skipped ?? 0) : '',
    passed: r.summary?.passed ?? '',
    failed: r.summary?.failed ?? '',
    startedAt: r.startedAt,
    endedAt: r.endedAt ?? '',
    duration: formatDurationBetween(r.startedAt, r.endedAt),
    exitCode: r.exitCode ?? '',
    command: r.command,
  }));
  const headers = Object.keys(rows[0] ?? {});
  const csv = [
    headers.join(','),
    ...rows.map((row) =>
      headers
        .map((h) => `"${String((row as Record<string, unknown>)[h] ?? '').replace(/"/g, '""')}"`)
        .join(','),
    ),
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `run-history-${dayjs().format('YYYY-MM-DD')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
