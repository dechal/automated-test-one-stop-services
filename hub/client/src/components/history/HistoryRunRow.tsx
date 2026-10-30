import type { RunRecord, ToolView } from '@hub/shared';
import { parseTagExpr } from '@hub/shared';
import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Group,
  Menu,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { TbCopy, TbDots, TbPlayerPlay, TbRefreshAlert, TbTerminal } from 'react-icons/tb';
import { PassScoreCell } from '~/components/PassScoreCell.js';
import { RunStatusBadge } from '~/components/RunStatusBadge.js';
import { useT } from '~/i18n/index.js';
import { formatAbsolute, formatDurationBetween, formatRelative } from '~/utils/datetime.js';
import { formatCompactNumber } from '~/utils/format-number.js';
import { formatPneBreakdown } from '~/utils/run-status.js';
import { toolLabel } from '~/utils/tool-label.js';

export interface HistoryRunRowProps {
  r: RunRecord;
  tools: readonly ToolView[];
  sharedProject: string | null;
  sharedType: string | null;
  advancedMode: boolean;
  compareChecked: boolean;
  toggleCompare: (id: string) => void;
  handleRerun: (run: RunRecord) => void;
  onRerunFailed: (run: RunRecord) => void;
  handleCopyCommand: (command: string) => void;
  handleViewLog: (run: RunRecord) => void;
}

export function HistoryRunRow({
  r,
  tools,
  sharedProject,
  sharedType,
  advancedMode,
  compareChecked,
  toggleCompare,
  handleRerun,
  onRerunFailed,
  handleCopyCommand,
  handleViewLog,
}: HistoryRunRowProps) {
  const t = useT();
  return (
    <Table.Tr>
      <Table.Td>
        <Checkbox
          size="xs"
          checked={compareChecked}
          onChange={() => toggleCompare(r.id)}
          aria-label={t('compare.button')}
        />
      </Table.Td>
      <Table.Td style={{ whiteSpace: 'nowrap' }}>
        {/* Same outcome vocabulary as Reports: a run whose tests
            failed and a run that never produced a result are
            different problems and must not read alike. */}
        <RunStatusBadge status={r.status} summary={r.summary} />
      </Table.Td>
      {/* Tool / mode / trigger are context, not signals. As pills
          they gave every row five coloured chips and nothing stood
          out; as dim text the status badge is the only colour in
          the row and the eye lands on it. */}
      <Table.Td>
        <Tooltip label={toolLabel(r.request.tool, tools)} withArrow>
          <Text size="xs" c="dimmed" truncate maw={90}>
            {toolLabel(r.request.tool, tools)}
          </Text>
        </Tooltip>
      </Table.Td>
      {sharedProject === null && (
        <Table.Td>
          <Tooltip label={`${r.request.tool}/${r.request.type}/${r.request.project}`}>
            <Text size="xs" fw={500} truncate maw={160}>
              {r.request.project}
            </Text>
          </Tooltip>
        </Table.Td>
      )}
      {sharedType === null && (
        <Table.Td>
          <Tooltip label={r.request.type} withArrow>
            <Text size="xs" truncate maw={80}>
              {r.request.type}
            </Text>
          </Tooltip>
        </Table.Td>
      )}
      <Table.Td>
        {r.summary ? (
          <Tooltip
            label={`${(
              r.summary.passed + r.summary.failed + (r.summary.skipped ?? 0)
            ).toLocaleString()}${r.summary.pne ? ` (${formatPneBreakdown(r.summary.pne, t)})` : ''}`}
            withArrow
          >
            <Text size="xs" c="dimmed">
              {formatCompactNumber(r.summary.passed + r.summary.failed + (r.summary.skipped ?? 0))}
            </Text>
          </Tooltip>
        ) : (
          <Text size="xs" c="dimmed">
            —
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <PassScoreCell summary={r.summary} severity={r.severity} />
      </Table.Td>
      <Table.Td>
        {r.request.tag ? (
          <Tooltip label={r.request.tag} withArrow>
            {/* One line, same rule as the Reports tag cell: stacked
                chips made these rows twice the height of their
                neighbours and the eye lost the row rhythm. The
                tooltip still carries the full expression. */}
            <Group gap={4} wrap="nowrap" maw={130}>
              <Badge size="xs" variant="outline" color="blue" style={{ minWidth: 0 }}>
                {(parseTagExpr(r.request.tag)[0] ?? '').replace(/^@/, '')}
              </Badge>
              {parseTagExpr(r.request.tag).length > 1 && (
                <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                  +{parseTagExpr(r.request.tag).length - 1}
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
      <Table.Td>
        {/* Docker is the exception worth marking, local is the
            norm — so only the exception gets any colour. */}
        <Tooltip label={r.request.mode} withArrow>
          <Text size="xs" truncate maw={80} c={r.request.mode === 'docker' ? 'violet.4' : 'dimmed'}>
            {r.request.mode}
          </Text>
        </Tooltip>
      </Table.Td>
      <Table.Td>
        <Tooltip label={t(`trigger.${r.triggeredBy ?? 'manual'}`)} withArrow>
          <Text size="xs" c="dimmed" truncate maw={90}>
            {t(`trigger.${r.triggeredBy ?? 'manual'}`)}
          </Text>
        </Tooltip>
      </Table.Td>
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
        <Tooltip
          label={
            r.endedAt
              ? `${formatAbsolute(r.startedAt)} → ${formatAbsolute(r.endedAt)}`
              : formatAbsolute(r.startedAt)
          }
          withArrow
        >
          <Text size="xs" ff="monospace">
            {formatDurationBetween(r.startedAt, r.endedAt)}
          </Text>
        </Tooltip>
      </Table.Td>
      <Table.Td>
        <Tooltip label={formatAbsolute(r.startedAt)}>
          <Text size="xs" c="dimmed">
            {formatRelative(r.startedAt)}
          </Text>
        </Tooltip>
      </Table.Td>
      {advancedMode && (
        <Table.Td>
          <Text size="xs" ff="monospace" c={r.exitCode === 0 ? 'green' : 'red'}>
            {r.exitCode ?? '-'}
          </Text>
        </Table.Td>
      )}
      <Table.Td>
        <Group gap={4} wrap="nowrap">
          <Tooltip label={t('history.rerun')}>
            <ActionIcon
              variant="subtle"
              size="sm"
              onClick={() => handleRerun(r)}
              aria-label={t('history.rerun')}
            >
              <TbPlayerPlay size={12} />
            </ActionIcon>
          </Tooltip>
          {/* Secondary actions live behind one trigger. Four
              buttons per row put ~125 targets on a 25-row page and
              ate the width the data columns needed; the two most
              used stay out, the rest are one click away. */}
          <Menu position="bottom-end" withArrow>
            <Menu.Target>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label={t('history.moreActions')}
              >
                <TbDots size={14} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {/* Only offered where there is something to narrow
                  to — a green run has no failures to re-select. */}
              {(r.status === 'failed' || r.status === 'error') && (
                <Menu.Item
                  leftSection={<TbRefreshAlert size={14} />}
                  onClick={() => onRerunFailed(r)}
                >
                  {t('history.rerunFailed')}
                </Menu.Item>
              )}
              <Menu.Item
                leftSection={<TbCopy size={14} />}
                onClick={() => handleCopyCommand(r.command)}
              >
                {t('history.copyCommand')}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
          <Button
            size="compact-xs"
            variant="light"
            leftSection={<TbTerminal size={12} />}
            onClick={() => handleViewLog(r)}
          >
            {t('history.details')}
          </Button>
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}
