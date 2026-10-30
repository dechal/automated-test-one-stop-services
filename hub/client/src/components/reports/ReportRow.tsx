import type { ReportEntry, RunSummary } from '@hub/shared';
import { parseTagExpr } from '@hub/shared';
import { ActionIcon, Badge, Button, Checkbox, Group, Table, Text, Tooltip } from '@mantine/core';
import { TbExternalLink, TbLock, TbLockOpen, TbStar, TbStarFilled, TbTrash } from 'react-icons/tb';
import { api } from '~/api/client.js';
import { PassScoreCell } from '~/components/PassScoreCell.js';
import { RunStatusBadge } from '~/components/RunStatusBadge.js';
import { ArtifactMenu } from '~/components/reports/ArtifactMenu.js';
import { toast } from '~/components/Toast.js';
import { useT } from '~/i18n/index.js';
import { formatAbsolute, formatDurationMs, formatRelative } from '~/utils/datetime.js';
import { formatCompactNumber } from '~/utils/format-number.js';
import { formatPneBreakdown } from '~/utils/run-status.js';

/**
 * "Cases" cell: total test-case count for a report, with a red badge when any
 * failed and a full pass/fail/skip breakdown in the tooltip. Shows a dash when
 * the report has no matching run summary (e.g. an aged-out run).
 */
function CaseCountCell({ summary }: { summary?: RunSummary }) {
  const t = useT();
  if (!summary) {
    return (
      <Text size="xs" c="dimmed">
        —
      </Text>
    );
  }
  const total = summary.passed + summary.failed + (summary.skipped ?? 0);
  const breakdown = `${total.toLocaleString()} ${t('reports.cases').toLowerCase()} — ${summary.passed.toLocaleString()} ${t('run.passed')} · ${summary.failed.toLocaleString()} ${t('run.failed')}${
    summary.skipped ? ` · ${summary.skipped.toLocaleString()} ${t('run.skipped')}` : ''
  }${summary.pne ? ` (${formatPneBreakdown(summary.pne, t)})` : ''}`;
  return (
    <Tooltip label={breakdown} withArrow>
      <Group gap={5} wrap="nowrap">
        <Text size="xs" fw={600}>
          {formatCompactNumber(total)}
        </Text>
        {summary.failed > 0 && (
          <Badge size="xs" color="red" variant="light">
            {formatCompactNumber(summary.failed)}
          </Badge>
        )}
      </Group>
    </Tooltip>
  );
}

export interface ReportRowProps {
  r: ReportEntry;
  selected: boolean;
  advancedMode: boolean;
  sharedProject: string | null;
  sharedType: string | null;
  toggleRow: (reportPath: string) => void;
  onFavorite: (path: string, on: boolean) => void;
  onLock: (reportPath: string) => void;
  onUnlock: (reportPath: string) => void;
  handleDelete: (reportPath: string) => void;
}

export function ReportRow({
  r,
  selected,
  advancedMode,
  sharedProject,
  sharedType,
  toggleRow,
  onFavorite,
  onLock,
  onUnlock,
  handleDelete,
}: ReportRowProps) {
  const t = useT();
  return (
    <Table.Tr bg={selected ? 'var(--mantine-color-brand-light)' : undefined}>
      <Table.Td>
        {/* A favourite cannot be selected at all: the only thing the
            selection drives is bulk delete, so allowing the tick
            would offer an action that is guaranteed to be refused. */}
        <Checkbox
          size="xs"
          checked={selected}
          disabled={r.favorite}
          onChange={() => toggleRow(r.reportPath)}
          aria-label={`${t('reports.selectRow')} ${r.project}`}
        />
      </Table.Td>
      <Table.Td style={{ whiteSpace: 'nowrap' }}>
        {/* Outcome, not the raw output folder. `r.status` only says
            which directory the runner wrote into, so a run with a
            few failing tests badged as `ERROR` — indistinguishable
            from a run that never produced a result. */}
        <RunStatusBadge status={r.status} summary={r.summary} />
      </Table.Td>
      {advancedMode && (
        <Table.Td>
          <Tooltip label={r.tool} withArrow>
            <Text size="xs" truncate maw={120}>
              {r.tool}
            </Text>
          </Tooltip>
        </Table.Td>
      )}
      {sharedProject === null && (
        <Table.Td>
          <Tooltip label={r.project} withArrow>
            <Text size="xs" fw={500} truncate maw={150}>
              {r.project}
            </Text>
          </Tooltip>
        </Table.Td>
      )}
      {sharedType === null && (
        <Table.Td>
          <Tooltip label={r.type} withArrow>
            <Text size="xs" truncate maw={80}>
              {r.type}
            </Text>
          </Tooltip>
        </Table.Td>
      )}
      <Table.Td>
        <CaseCountCell summary={r.summary} />
      </Table.Td>
      <Table.Td>
        <PassScoreCell summary={r.summary} severity={r.severity} />
      </Table.Td>
      <Table.Td>
        {r.durationMs !== undefined ? (
          <Tooltip label={`${r.durationMs.toLocaleString()} ms`} withArrow>
            <Text size="xs" ff="monospace">
              {formatDurationMs(r.durationMs)}
            </Text>
          </Tooltip>
        ) : (
          <Text size="xs" c="dimmed">
            —
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        {r.runTag ? (
          <Tooltip label={r.runTag} withArrow>
            <Group gap={4} wrap="nowrap" maw={150}>
              {/* Tags are a filter record, not a status. As outlined
                  blue chips they out-shouted the pass rate — the
                  one number this table exists to show.
                  `nowrap` is load-bearing: wrapping made a two-tag
                  row roughly 3x taller than its neighbours, and that
                  uneven rhythm is what made the table hard to scan.
                  The tooltip still holds the full expression, so the
                  cell re-flows without hiding anything. */}
              {/* ONE tag, readable, plus a count. Two tags sharing
                  150px each truncated to `fire-bene…` / `fire-spec…`
                  — two fragments that identify nothing, and with
                  exactly two tags no overflow hint appeared either.
                  One legible name plus `+N` says more in less space;
                  the tooltip still has the full expression. */}
              <Text size="xs" c="dimmed" ff="monospace" truncate>
                {(parseTagExpr(r.runTag)[0] ?? '').replace(/^@/, '')}
              </Text>
              {parseTagExpr(r.runTag).length > 1 && (
                <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                  +{parseTagExpr(r.runTag).length - 1}
                </Text>
              )}
            </Group>
          </Tooltip>
        ) : (
          <Text size="xs" c="dimmed">
            {t('reports.allTests')}
          </Text>
        )}
      </Table.Td>
      {advancedMode && (
        <Table.Td>
          {r.runMode ? (
            <Tooltip label={r.runMode} withArrow>
              <Badge
                size="xs"
                variant="light"
                color={r.runMode === 'docker' ? 'violet' : 'gray'}
                style={{ maxWidth: '100%' }}
              >
                {r.runMode}
              </Badge>
            </Tooltip>
          ) : (
            <Text size="xs" c="dimmed">
              —
            </Text>
          )}
        </Table.Td>
      )}
      <Table.Td>
        {r.envProfileName || r.environment ? (
          <Tooltip label={r.environment ?? '—'} withArrow>
            <Text size="xs" c="dimmed" truncate maw={100}>
              {r.envProfileName ?? r.environment}
            </Text>
          </Tooltip>
        ) : (
          <Text size="xs" c="dimmed">
            —
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <Tooltip label={formatAbsolute(r.timestamp)} withArrow>
          <Text size="xs" c="dimmed">
            {formatRelative(r.timestamp)}
          </Text>
        </Tooltip>
      </Table.Td>
      <Table.Td>
        <Group gap="xs" wrap="nowrap">
          <Button
            size="compact-xs"
            leftSection={<TbExternalLink size={12} />}
            onClick={async () => {
              // Ask the server to open the report with the OS
              // default app so it loads as a real file:// path.
              // (A localhost page can't navigate to file://.)
              try {
                await api.post('/api/reports/open-file', { path: r.reportPath });
              } catch {
                toast.error(t('reports.openFailed'));
              }
            }}
          >
            {t('reports.open')}
          </Button>
          <ArtifactMenu reportPath={r.reportPath} />
          {/* Lock and delete stay as their own icons rather than
              collapsing into a `⋯` menu: ArtifactMenu already owns a
              `⋯` on this row, so a second identical trigger beside it
              was ambiguous, and the table scrolls horizontally, so
              the column has room. Delete still confirms first. */}
          <Tooltip label={r.favorite ? t('reports.unfavorite') : t('reports.favorite')}>
            <ActionIcon
              variant="subtle"
              color={r.favorite ? 'yellow' : 'gray'}
              size="sm"
              onClick={() => onFavorite(r.reportPath, !r.favorite)}
              aria-label={r.favorite ? t('reports.unfavorite') : t('reports.favorite')}
            >
              {r.favorite ? <TbStarFilled size={14} /> : <TbStar size={14} />}
            </ActionIcon>
          </Tooltip>
          {/* Disabled while favourited: the favourite owns the lock,
              so offering an unlock that the server would refuse is
              worse than showing the reason. Rendered always (never
              hidden) so the row's icons never shift position. */}
          <Tooltip
            label={
              r.favorite
                ? t('reports.lockedByFavorite')
                : r.locked
                  ? t('reports.unlockHint')
                  : t('reports.lockHint')
            }
          >
            <ActionIcon
              variant="subtle"
              color={r.locked ? 'yellow' : 'gray'}
              size="sm"
              disabled={r.favorite}
              onClick={() => (r.locked ? onUnlock(r.reportPath) : onLock(r.reportPath))}
              aria-label={r.locked ? t('reports.unlockReport') : t('reports.lockReport')}
            >
              {r.locked ? <TbLock size={14} /> : <TbLockOpen size={14} />}
            </ActionIcon>
          </Tooltip>
          <Tooltip label={r.favorite ? t('reports.favoriteNoDelete') : t('reports.deleteAria')}>
            <ActionIcon
              variant="subtle"
              color="red"
              size="sm"
              disabled={r.favorite}
              onClick={() => handleDelete(r.reportPath)}
              aria-label={t('reports.deleteAria')}
            >
              <TbTrash size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}
