import type { RunSummary, SeverityBreakdown } from '@hub/shared';
import { SEVERITY_LEVELS, weightedPassPercent } from '@hub/shared';
import { Group, Progress, Text, Tooltip } from '@mantine/core';
import { useT } from '~/i18n/index.js';
import { formatCompactNumber } from '~/utils/format-number.js';
import { formatPneBreakdown } from '~/utils/run-status.js';

/**
 * Ring size matches the `Badge size="sm"` (1.125rem = 18px) that every row of
 * both tables renders in its status cell, so this cell is never the tallest one
 * and row height — which the tables' scroll maths depend on — is unchanged.
 * Mantine clamps thickness at size/4.
 */
const BAR_WIDTH = 44;
const BAR_HEIGHT = 4;

/**
 * Severity-weighted pass score cell, shared by the History and Reports tables.
 *
 * - When a `severity` breakdown is present → weighted % (critical×4 / high×3 /
 *   medium×2 / low×1), tooltip shows per-level passed/failed counts.
 * - When only a `summary` is present → plain pass rate, tooltip notes the reason.
 * - When neither is present → dash.
 *
 * Color scale: ≥80% green · ≥50% yellow · <50% red. The ring restates the number
 * it sits next to, so colour is never the only carrier of the score.
 */
export function PassScoreCell({
  summary,
  severity,
  showCount = true,
}: {
  summary?: RunSummary;
  severity?: SeverityBreakdown;
  showCount?: boolean;
}) {
  const t = useT();

  if (!summary && !severity) {
    return (
      <Text size="xs" c="dimmed">
        —
      </Text>
    );
  }

  const weighted = severity ? weightedPassPercent(severity) : null;

  let pct: number | null = null;
  if (weighted !== null) {
    pct = weighted;
  } else if (summary) {
    const total = summary.passed + summary.failed + (summary.skipped ?? 0);
    pct = total > 0 ? (summary.passed / total) * 100 : null;
  }

  const display = pct !== null ? `${pct.toFixed(1)}%` : '—';
  const color =
    pct === null
      ? ('dimmed' as const)
      : pct >= 80
        ? ('green' as const)
        : pct >= 50
          ? ('yellow' as const)
          : ('red' as const);

  const tooltipLines: string[] = [];
  if (weighted !== null && severity) {
    tooltipLines.push(t('reports.scoreWeighted'));
    for (const level of SEVERITY_LEVELS) {
      const { passed, failed } = severity[level];
      if (passed + failed === 0) continue;
      tooltipLines.push(
        t('reports.scoreSeverityRow')
          .replace('{level}', level)
          .replace('{passed}', passed.toLocaleString())
          .replace('{failed}', failed.toLocaleString()),
      );
    }
  } else {
    tooltipLines.push(t('reports.scoreNoSeverity'));
    if (summary) {
      const total = summary.passed + summary.failed + (summary.skipped ?? 0);
      tooltipLines.push(
        `${summary.passed.toLocaleString()} ${t('run.passed')} · ${summary.failed.toLocaleString()} ${t('run.failed')}` +
          (summary.skipped ? ` · ${summary.skipped.toLocaleString()} ${t('run.skipped')}` : '') +
          ` / ${total.toLocaleString()}`,
      );
    }
  }
  if (summary?.pne) {
    tooltipLines.push(formatPneBreakdown(summary.pne, t));
  }

  return (
    <Tooltip
      label={
        <Text size="xs" style={{ whiteSpace: 'pre-line' }}>
          {tooltipLines.join('\n')}
        </Text>
      }
      withArrow
    >
      <Group gap={8} wrap="nowrap">
        {pct !== null && (
          <Progress.Root w={BAR_WIDTH} size={BAR_HEIGHT} aria-hidden>
            <Progress.Section value={pct} color="green.7" />
            <Progress.Section value={100 - pct} color="red.8" />
          </Progress.Root>
        )}
        <Text size="xs" fw={500} c={color === 'red' ? 'red.4' : undefined} ff="monospace">
          {display}
        </Text>
        {summary && showCount && (
          <Text size="xs" c="dimmed" ff="monospace">
            {formatCompactNumber(summary.passed)}/
            {formatCompactNumber(summary.passed + summary.failed + (summary.skipped ?? 0))}
          </Text>
        )}
      </Group>
    </Tooltip>
  );
}
