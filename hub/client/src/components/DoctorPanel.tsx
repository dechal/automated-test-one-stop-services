import type { DoctorCategory, DoctorCheck, DoctorReport } from '@hub/shared';
import { missingPrerequisites } from '@hub/shared';
import {
  Badge,
  Box,
  Button,
  Collapse,
  Grid,
  Group,
  Loader,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useState } from 'react';
import {
  TbAlertTriangle,
  TbChevronRight,
  TbCircleCheck,
  TbCircleDashed,
  TbCircleX,
  TbDownload,
  TbHelpCircle,
  TbRefresh,
} from 'react-icons/tb';
import { ServiceActions } from '~/components/ServiceActions.js';
import { useInstallPython, useProvisionTool } from '~/hooks/useTools.js';
import type { TranslationKey } from '~/i18n/en';
import { useT } from '~/i18n/index.js';
import { usePreferences } from '~/stores/hub.js';
import {
  type DoctorToolGroup,
  groupByCategory,
  groupByTool,
  provisionGuidance,
  provisionTargetFor,
  shouldAutoExpand,
  shouldShowGroup,
  summaryBadge,
} from './doctor-panel-helpers';

interface DoctorPanelProps {
  doctor: DoctorReport | undefined;
  isLoading: boolean;
}

/**
 * Per-tool provisioning UI state, threaded from {@link DoctorPanel} down to each
 * {@link CheckCard}. Derived from the single `useProvisionTool` mutation so only
 * the card whose tool is being provisioned shows a spinner.
 */
interface ProvisionState {
  /** Trigger a (re-)provision for the given tool id. */
  onProvision: (toolId: string) => void;
  /** Tool id currently being provisioned (spinner target), if any. */
  pendingId: string | undefined;
  /** Tool id whose last provision attempt failed in-band, if any. */
  failedId: string | undefined;
  /** Message from the last failed provision attempt, if any. */
  failedMessage: string | undefined;
}

/**
 * One-click install UI state for the (single) Python check. Threaded like
 * {@link ProvisionState}, but there is only one installable check so no id
 * tracking is needed.
 */
interface InstallState {
  /** Trigger the retroactive Python install. */
  onInstall: () => void;
  /** Whether the install is in flight (spinner). */
  isPending: boolean;
  /** Whether the last attempt failed. */
  failed: boolean;
  /** Error (on failure) or non-fatal warning (on success) to surface, if any. */
  note: string | undefined;
}

interface CategoryConfig {
  key: DoctorCategory;
  titleKey: TranslationKey;
  tagKey?: TranslationKey;
  /**
   * Left-edge accent for a FAILING check. There is deliberately no ok/fail
   * background or outline colour: each card already carries a status icon, so a
   * tinted fill behind it said the same thing a second time — and eleven filled
   * cards made the healthy state shout as loudly as the broken one.
   */
  failAccent: string;
  failIcon: 'x' | 'warn';
}

const GENERAL_GROUP_KEY = 'general';
const INLINE_CHECK_MIN_WIDTH = 160;

const CATEGORIES: CategoryConfig[] = [
  {
    key: 'required-install',
    titleKey: 'doctor.catRequired',
    failAccent: 'var(--mantine-color-red-6)',
    failIcon: 'x',
  },
  {
    key: 'optional-install',
    titleKey: 'doctor.catOptionalInstall',
    tagKey: 'doctor.tagOptional',
    failAccent: 'var(--mantine-color-yellow-6)',
    failIcon: 'warn',
  },
  {
    key: 'optional-process',
    titleKey: 'doctor.catOptionalServices',
    tagKey: 'doctor.tagService',
    // A stopped optional service is a fact, not a fault — neutral accent.
    failAccent: 'var(--mantine-color-dark-3)',
    failIcon: 'x',
  },
];

/**
 * Environment status panel.
 *
 * When all required and optional-install checks pass, the panel collapses to
 * a single green badge to keep the dashboard clean. The user can expand to
 * inspect details. When any check fails the panel auto-expands so the user
 * cannot miss the problem.
 */
export function DoctorPanel({ doctor, isLoading }: DoctorPanelProps) {
  const t = useT();
  const hasIssues = !!doctor && shouldAutoExpand(doctor);
  const [expanded, setExpanded] = useState(false);
  const isExpanded = hasIssues || expanded;
  // With issues present the panel opens itself; healthy checks stay folded so the
  // problems are the content, not a needle in 11 green cards.
  const [showHealthy, setShowHealthy] = useState(false);
  // `optional-process` is Docker / InfluxDB / Grafana — infrastructure a basic
  // user never starts and cannot act on, so a stopped one reads as a broken Hub
  // rather than an unused extra. Advanced mode owns that surface.
  const visibleCategories = CATEGORIES;
  const visibleKeys = new Set(visibleCategories.map((c) => c.key));
  const okCount = doctor?.checks.filter((c) => c.ok && visibleKeys.has(c.category)).length ?? 0;

  const provision = useProvisionTool();
  // Derive per-tool provisioning UI state from the single in-flight mutation:
  // `pendingId` drives the spinner on the active card; `failedMessage` surfaces
  // the in-band `postInstallError` from the last failed Provision attempt.
  const provisionState: ProvisionState = {
    onProvision: (toolId) => provision.mutate(toolId),
    pendingId: provision.isPending ? provision.variables : undefined,
    failedId: provision.data && !provision.data.ok ? provision.variables : undefined,
    failedMessage: provision.data?.postInstallError?.message,
  };

  const installPython = useInstallPython();
  const installState: InstallState = {
    onInstall: () => installPython.mutate(),
    isPending: installPython.isPending,
    failed: !!installPython.data && !installPython.data.ok,
    note: installPython.data?.error?.message ?? installPython.data?.message,
  };

  if (isLoading || !doctor) {
    return (
      <Paper p="md" withBorder>
        <Group gap="xs">
          {isLoading && <Loader size="xs" />}
          <Text c="dimmed" size="sm">
            {t('doctor.checking')}
          </Text>
        </Group>
      </Paper>
    );
  }

  const badge = summaryBadge(doctor.checks);
  const toolGroups = groupByTool(doctor.checks);
  const allChecks = doctor.checks;

  function renderToolGroup(toolGroup: DoctorToolGroup, inline = false) {
    const groups = groupByCategory(toolGroup.checks);
    const sections = visibleCategories.flatMap((cat) => {
      // Opened because something is wrong? Then show what is wrong. The
      // healthy checks were taking most of the first screen to say
      // "fine" — the summary badge already says that in four characters.
      const all = groups[cat.key];
      // Filter only when the panel opened itself over a problem. When all
      // is well the user expanded on purpose, and the passing checks are
      // the only thing there is to show.
      const checks = showHealthy || !hasIssues ? all : all.filter((c) => !c.ok);
      if (checks.length === 0 || !shouldShowGroup(all)) return [];
      return [{ cat, checks }];
    });
    if (sections.length === 0) return null;
    const required = groups['required-install'];
    const requiredOk = required.filter((c) => c.ok).length;
    return (
      <Paper key={toolGroup.toolId ?? GENERAL_GROUP_KEY} withBorder radius="md" p="sm">
        <Group justify="space-between" wrap="nowrap" mb={6}>
          <Text size="sm" fw={600} truncate>
            {toolGroup.toolTitle ?? t('doctor.general')}
          </Text>
          {required.length > 0 && (
            <Badge
              size="xs"
              variant="light"
              color={requiredOk === required.length ? 'green' : 'red'}
              style={{ flexShrink: 0 }}
            >
              {`${requiredOk}/${required.length}`}
            </Badge>
          )}
        </Group>
        <Box
          style={
            inline
              ? {
                  display: 'flex',
                  flexWrap: 'wrap',
                  borderTop: '1px solid var(--mantine-color-default-border)',
                }
              : { display: 'flex', flexDirection: 'column' }
          }
        >
          {sections
            .flatMap(({ cat, checks }) => checks.map((check) => ({ cat, check })))
            .map(({ cat, check }, index) => (
              <CheckCard
                key={`${cat.key}:${check.name}`}
                check={check}
                cat={cat}
                allChecks={allChecks}
                provision={provisionState}
                install={installState}
                inline={inline}
                first={index === 0}
              />
            ))}
        </Box>
      </Paper>
    );
  }

  return (
    <Paper p="md" withBorder>
      <UnstyledButton
        w="100%"
        aria-expanded={isExpanded}
        aria-disabled={hasIssues || undefined}
        aria-label={t('doctor.toggleDetails')}
        style={{ cursor: hasIssues ? 'default' : 'pointer' }}
        onClick={() => {
          if (!hasIssues) setExpanded((v) => !v);
        }}
      >
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            {!hasIssues && (
              <TbChevronRight
                size={14}
                style={{
                  transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  transition: 'transform 200ms',
                }}
              />
            )}
            <Text fw={600} size="sm">
              {t('doctor.envStatus')}
            </Text>
            {badge.ok ? (
              <Badge
                color="green"
                variant="light"
                size="sm"
                leftSection={<TbCircleCheck size={12} />}
              >
                {`${t('doctor.catRequired')} ${badge.text}`}
              </Badge>
            ) : (
              <Badge color="red" variant="filled" size="sm" leftSection={<TbCircleX size={12} />}>
                {badge.text}
              </Badge>
            )}
          </Group>
        </Group>
      </UnstyledButton>

      <Collapse expanded={isExpanded}>
        <Stack gap="md" mt="md">
          {(() => {
            const [general, ...tools] = toolGroups;
            const generalCard = general ? renderToolGroup(general, true) : null;
            const toolCards = tools.map((g) => renderToolGroup(g)).filter((n) => n !== null);
            return (
              <Stack gap="sm">
                {generalCard}
                {toolCards.length > 0 && (
                  <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
                    {toolCards}
                  </SimpleGrid>
                )}
              </Stack>
            );
          })()}
          {hasIssues && (
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => setShowHealthy((v) => !v)}
            >
              {showHealthy ? t('doctor.hideHealthy') : `${t('doctor.showHealthy')} (${okCount})`}
            </Button>
          )}
        </Stack>
      </Collapse>
    </Paper>
  );
}

function CheckCard({
  check,
  cat,
  allChecks,
  provision,
  install,
  inline = false,
  first = false,
}: {
  check: DoctorCheck;
  cat: CategoryConfig;
  allChecks: DoctorCheck[];
  provision: ProvisionState;
  install: InstallState;
  inline?: boolean;
  first?: boolean;
}) {
  const [showFix, setShowFix] = useState(false);
  // An unverified check reads as "unknown", never as broken: neutral icon and
  // neutral text, so a busy machine cannot make an installed tool look missing.
  const notEnabled = cat.key === 'optional-process' && !check.ok && !check.unverified;
  const FailIcon = notEnabled
    ? TbCircleDashed
    : check.unverified
      ? TbHelpCircle
      : cat.failIcon === 'warn'
        ? TbAlertTriangle
        : TbCircleX;
  const failColor =
    check.unverified || notEnabled
      ? 'var(--mantine-color-dimmed)'
      : cat.failIcon === 'warn'
        ? 'var(--mantine-color-yellow-6)'
        : 'var(--mantine-color-red-6)';
  const hintColor =
    check.unverified || notEnabled ? 'dimmed' : cat.failIcon === 'warn' ? 'yellow.8' : 'red';

  // A failing tool check (e.g. playwright-browsers, k6) can be re-provisioned by
  // re-running the tool's `setup` task. Generic checks have no provision target.
  const t = useT();
  // No install/provision action while presence is unknown — the tool is probably
  // there, and re-provisioning it would be a slow no-op.
  const provisionTarget = check.ok || check.unverified ? undefined : provisionTargetFor(check.name);
  const isProvisioning = provisionTarget !== undefined && provision.pendingId === provisionTarget;
  const provisionFailed = provisionTarget !== undefined && provision.failedId === provisionTarget;

  // A failing check that carries an `install` kind (currently only `python`)
  // offers a one-click Hub-driven install instead of a shell command.
  const showInstall = !check.ok && !check.unverified && check.install === 'python';

  // Ordered install gate: an installable/provisionable check can only proceed
  // once its prerequisite checks pass (python needs uv; browsers need node+pnpm).
  // Block the action button and name what to install first — full gating.
  const prereqMissing =
    provisionTarget !== undefined || showInstall ? missingPrerequisites(check.name, allChecks) : [];
  const prereqBlocked = prereqMissing.length > 0;

  return (
    <Box
      py={6}
      px="xs"
      style={
        inline
          ? {
              flex: `1 1 ${INLINE_CHECK_MIN_WIDTH}px`,
              minWidth: 0,
              borderLeft:
                check.ok || check.unverified
                  ? first
                    ? '1px solid transparent'
                    : '1px solid var(--mantine-color-default-border)'
                  : `3px solid ${cat.failAccent}`,
            }
          : {
              borderTop: '1px solid var(--mantine-color-default-border)',
              borderLeft: `3px solid ${check.ok || check.unverified ? 'transparent' : cat.failAccent}`,
            }
      }
    >
      <Group gap={6} wrap="nowrap">
        {check.ok ? (
          <TbCircleCheck color="var(--mantine-color-green-6)" size={16} />
        ) : (
          <FailIcon color={failColor} size={16} />
        )}
        <Text size="sm" fw={500} truncate>
          {check.name}
        </Text>
        {notEnabled && (
          <Badge size="xs" color="gray" style={{ flexShrink: 0 }}>
            {t('doctor.notEnabled')}
          </Badge>
        )}
        {cat.tagKey && !inline && (
          <Text size="xs" c="dimmed" ml="auto" style={{ flexShrink: 0 }}>
            {t(cat.tagKey)}
          </Text>
        )}
      </Group>
      {check.ok && check.version && (
        <Text size="xs" c="dimmed" mt={2} pl={22} truncate title={check.version}>
          {check.version}
        </Text>
      )}
      {!check.ok && check.hint && (
        <Tooltip label={check.hint} multiline w={320}>
          <Text size="xs" c={hintColor} mt={2} pl={22} lineClamp={2}>
            {check.hint}
          </Text>
        </Tooltip>
      )}
      {provisionTarget && (
        <Stack gap={4} mt={6}>
          <Group gap={6} wrap="nowrap">
            <Button
              size="compact-xs"
              variant="light"
              leftSection={<TbRefresh size={12} />}
              loading={isProvisioning}
              disabled={prereqBlocked}
              onClick={() => provision.onProvision(provisionTarget)}
            >
              {t('doctor.provision')}
            </Button>
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              onClick={() => setShowFix((v) => !v)}
            >
              {t('doctor.howToFix')}
            </Button>
          </Group>
          {prereqBlocked && (
            <Text size="xs" c="red">
              Install {prereqMissing.join(', ')} first
            </Text>
          )}
          {provisionFailed && provision.failedMessage && (
            <Text size="xs" c="red" title={provision.failedMessage} lineClamp={2}>
              {provision.failedMessage}
            </Text>
          )}
          <Collapse expanded={showFix}>
            <Stack gap={4} mt={4}>
              {provisionGuidance(provisionTarget).map((step) => (
                <Text key={step.title} size="xs" c="dimmed">
                  <Text span size="xs" fw={700}>
                    {step.title}:
                  </Text>{' '}
                  {step.detail}
                </Text>
              ))}
            </Stack>
          </Collapse>
        </Stack>
      )}
      {showInstall && (
        <Stack gap={4} mt={6}>
          <Button
            size="compact-xs"
            variant="light"
            leftSection={<TbDownload size={12} />}
            loading={install.isPending}
            disabled={prereqBlocked}
            onClick={install.onInstall}
          >
            {t('doctor.installPython')}
          </Button>
          {prereqBlocked && (
            <Text size="xs" c="red">
              Install {prereqMissing.join(', ')} first
            </Text>
          )}
          {install.note && (
            <Text
              size="xs"
              c={install.failed ? 'red' : 'yellow.8'}
              title={install.note}
              lineClamp={2}
            >
              {install.note}
            </Text>
          )}
        </Stack>
      )}
      {check.service && <ServiceActions check={check} allChecks={allChecks} />}
    </Box>
  );
}
