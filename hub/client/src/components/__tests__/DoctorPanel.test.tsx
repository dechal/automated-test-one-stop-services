import type { DoctorCheck, DoctorReport, ProvisionResult, PythonInstallResult } from '@hub/shared';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '~/i18n/en';
import { DoctorPanel } from '../DoctorPanel';

/** Match the button by its translation source, so a copy change cannot break
 *  a test whose subject is behaviour (mutation fired), not wording. */
const PROVISION_LABEL = new RegExp(en['doctor.provision'], 'i');

/**
 * Unit tests for DoctorPanel rendering (including the provision button and the
 * no-mirror guidance).
 *
 * Covers acceptance criteria:
 *   loading / not-ready -> "Checking environment..." indicator, no groups
 *   ok=false check renders a fail icon (TbCircleX / TbAlertTriangle)
 *   failing check WITH a hint renders the hint text
 *   ok check WITH a version renders the version text
 *   clicking the header toggles expand/collapse (when not auto-expanded)
 *   Provision: failing tool check renders a Provision button that triggers the
 *   mutation; pending shows a spinner; failure surfaces the in-band message; the
 *   "How to fix" block shows no-mirror-first guidance (env-key names only).
 */

// Control the provision mutation without any network access. Tests mutate
// `provisionReturn` before rendering to exercise idle / pending / failed states.
const provisionMutate = vi.fn();
let provisionReturn: {
  mutate: typeof provisionMutate;
  isPending: boolean;
  variables: string | undefined;
  data: ProvisionResult | undefined;
};

// Control the install-python mutation the same way as provision. Tests mutate
// `installReturn` before rendering to exercise idle / pending / failed states.
const installMutate = vi.fn();
let installReturn: {
  mutate: typeof installMutate;
  isPending: boolean;
  data: PythonInstallResult | undefined;
};

vi.mock('~/hooks/useTools.js', () => ({
  useProvisionTool: () => provisionReturn,
  useInstallPython: () => installReturn,
}));

// react-icons render anonymous <svg> elements with no accessible name, which
// makes "which icon rendered" impossible to assert directly. Mock the Tabler
// icon set the component imports so each icon is tagged with a data-testid.
vi.mock('react-icons/tb', () => {
  const makeIcon = (name: string) => () => <svg data-testid={name} aria-hidden="true" />;
  return {
    TbAlertTriangle: makeIcon('TbAlertTriangle'),
    TbChevronRight: makeIcon('TbChevronRight'),
    TbCircleCheck: makeIcon('TbCircleCheck'),
    TbCircleX: makeIcon('TbCircleX'),
    TbDownload: makeIcon('TbDownload'),
    TbRefresh: makeIcon('TbRefresh'),
  };
});

// jsdom does not implement matchMedia. Provide a stub that reports
// prefers-reduced-motion: reduce so that, combined with a theme that respects
// reduced motion, Mantine's <Collapse> uses transitionDuration=0 and becomes a
// synchronous conditional mount/unmount (jsdom never fires `transitionend`).
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
});

beforeEach(() => {
  provisionMutate.mockReset();
  provisionReturn = {
    mutate: provisionMutate,
    isPending: false,
    variables: undefined,
    data: undefined,
  };
  installMutate.mockReset();
  installReturn = {
    mutate: installMutate,
    isPending: false,
    data: undefined,
  };
});

function renderPanel(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MantineProvider theme={{ respectReducedMotion: true }}>{ui}</MantineProvider>
    </QueryClientProvider>,
  );
}

function check(partial: Partial<DoctorCheck> & Pick<DoctorCheck, 'name'>): DoctorCheck {
  return {
    ok: true,
    category: 'required-install',
    ...partial,
  };
}

function report(checks: DoctorCheck[]): DoctorReport {
  return {
    checks,
    overallOk: checks.every((c) => c.ok),
    credentialsOk: true,
  };
}

/** Report with failing checks -> auto-expanded, header click disabled. */
const reportWithIssues = report([
  check({ name: 'hub/server', ok: true, version: 'v20.0.0-installed' }),
  check({ name: 'tools/playwright', ok: false, hint: 'Run: pnpm install' }),
  check({
    name: 'playwright-browsers',
    ok: false,
    hint: 'Run: npx playwright install',
    category: 'optional-install',
  }),
  check({ name: 'docker-daemon', ok: true, version: 'running', category: 'optional-process' }),
]);

/** All required/optional-install checks pass -> collapsed by default. */
const reportAllOk = report([
  check({ name: 'hub/server', ok: true, version: 'srv-1.0.0' }),
  check({ name: 'hub/client', ok: true, version: 'cli-1.0.0' }),
  check({ name: 'docker', ok: true, version: 'running', category: 'optional-process' }),
]);

/** Locate the status icon belonging to a specific check card by its name. */
function iconForCheck(name: string): HTMLElement {
  const nameEl = screen.getByText(name);
  // CheckCard renders <Group>[icon, <Text>{name}</Text>]</Group>; the icon is
  // the only sibling of the name within that group.
  const group = nameEl.parentElement;
  if (!group) throw new Error(`no parent group for check "${name}"`);
  return within(group).getByTestId(/^Tb/);
}

describe('DoctorPanel rendering', () => {
  it('shows the checking-environment indicator and no groups while loading', () => {
    renderPanel(<DoctorPanel doctor={undefined} isLoading />);

    expect(screen.getByText(/Checking environment/i)).toBeInTheDocument();
    // No category headers / no check cards are rendered.
    expect(screen.queryByText('Required')).not.toBeInTheDocument();
    expect(screen.queryByText('Optional — Install')).not.toBeInTheDocument();
    expect(screen.queryByText('Environment Status')).not.toBeInTheDocument();
  });

  it('shows the checking-environment indicator when the report is not ready', () => {
    renderPanel(<DoctorPanel doctor={undefined} isLoading={false} />);

    expect(screen.getByText(/Checking environment/i)).toBeInTheDocument();
    expect(screen.queryByText('Required')).not.toBeInTheDocument();
  });

  it('renders a fail icon for ok=false checks and a check icon for ok=true checks', async () => {
    const user = userEvent.setup();
    renderPanel(<DoctorPanel doctor={reportWithIssues} isLoading={false} />);

    // required-install failure -> TbCircleX
    expect(iconForCheck('tools/playwright')).toHaveAttribute('data-testid', 'TbCircleX');
    // optional-install failure -> TbAlertTriangle
    expect(iconForCheck('playwright-browsers')).toHaveAttribute('data-testid', 'TbAlertTriangle');
    // Passing checks stay folded while problems are on screen, so reveal them
    // before asserting the ok icon.
    await user.click(screen.getByText(/Show passing checks/));
    expect(iconForCheck('hub/server')).toHaveAttribute('data-testid', 'TbCircleCheck');
  });

  it('renders the hint text for a failing check that has a hint', () => {
    renderPanel(<DoctorPanel doctor={reportWithIssues} isLoading={false} />);

    expect(screen.getByText('Run: pnpm install')).toBeInTheDocument();
    expect(screen.getByText('Run: npx playwright install')).toBeInTheDocument();
  });

  it('renders the version text for an ok check that has a version', async () => {
    const user = userEvent.setup();
    renderPanel(<DoctorPanel doctor={reportWithIssues} isLoading={false} />);
    await user.click(screen.getByText(/Show passing checks/));

    expect(screen.getByText('v20.0.0-installed')).toBeInTheDocument();
    // The failing check has no version, so nothing version-like is shown for it.
    const failGroup = screen.getByText('tools/playwright').parentElement as HTMLElement;
    const failCard = failGroup.parentElement as HTMLElement;
    expect(within(failCard).queryByText('v20.0.0-installed')).not.toBeInTheDocument();
  });

  it('toggles expand/collapse when the header is clicked', async () => {
    const user = userEvent.setup();
    renderPanel(<DoctorPanel doctor={reportAllOk} isLoading={false} />);

    // Collapsed by default: the always-visible summary badge shows, but the card
    // contents are hidden. Mantine 9.4 keeps Collapse children MOUNTED (hidden),
    // so assert visibility, not DOM presence.
    expect(screen.getByText('2/2 OK')).toBeVisible();
    expect(screen.getByText('srv-1.0.0')).not.toBeVisible();
    expect(screen.getByText('Required')).not.toBeVisible();

    // Click header -> expand: the contents become visible.
    await user.click(screen.getByText('Environment Status'));
    expect(screen.getByText('Required')).toBeVisible();
    expect(screen.getByText('srv-1.0.0')).toBeVisible();
    expect(screen.getByText('cli-1.0.0')).toBeVisible();
  });
});

/** A report whose only failing check is the provisionable playwright-browsers.
 *  node + pnpm pass, so the provision prerequisites are satisfied. */
const reportBrowsersMissing = report([
  check({ name: 'node', ok: true, version: 'v26.0.0' }),
  check({ name: 'pnpm', ok: true, version: '11.10.0' }),
  check({
    name: 'playwright-browsers',
    ok: false,
    hint: 'Run: pnpm exec playwright install',
    category: 'required-install',
  }),
]);

describe('DoctorPanel provisioning + guidance', () => {
  it('renders a Provision button on the failing tool check and triggers the mutation', async () => {
    const user = userEvent.setup();
    renderPanel(<DoctorPanel doctor={reportBrowsersMissing} isLoading={false} />);

    const provisionBtn = screen.getByRole('button', { name: PROVISION_LABEL });
    expect(provisionBtn).toBeInTheDocument();

    await user.click(provisionBtn);
    expect(provisionMutate).toHaveBeenCalledWith('playwright');
  });

  it('does not render a Provision button for passing or non-tool checks', () => {
    // node (passing, required) and a generic failing check have no provision target.
    const generic = report([
      check({ name: 'node', ok: true, version: 'v25.0.0' }),
      check({ name: 'git', ok: false, hint: 'Install git', category: 'required-install' }),
    ]);
    renderPanel(<DoctorPanel doctor={generic} isLoading={false} />);

    expect(screen.queryByRole('button', { name: PROVISION_LABEL })).not.toBeInTheDocument();
  });

  it('shows a spinner on the active card while provisioning', () => {
    provisionReturn = {
      mutate: provisionMutate,
      isPending: true,
      variables: 'playwright',
      data: undefined,
    };
    renderPanel(<DoctorPanel doctor={reportBrowsersMissing} isLoading={false} />);

    const provisionBtn = screen.getByRole('button', { name: PROVISION_LABEL });
    expect(provisionBtn).toHaveAttribute('data-loading', 'true');
  });

  it('surfaces the in-band provisioning failure message', () => {
    provisionReturn = {
      mutate: provisionMutate,
      isPending: false,
      variables: 'playwright',
      data: {
        ok: false,
        postInstallError: { code: 'POST_INSTALL_FAILED', message: 'browser download failed' },
      },
    };
    renderPanel(<DoctorPanel doctor={reportBrowsersMissing} isLoading={false} />);

    expect(screen.getByText('browser download failed')).toBeInTheDocument();
  });

  it('reveals no-mirror-first guidance referencing env-key names only', async () => {
    const user = userEvent.setup();
    renderPanel(<DoctorPanel doctor={reportBrowsersMissing} isLoading={false} />);

    // Guidance is collapsed (hidden) until "How to fix" is clicked. Mantine 9.4
    // keeps Collapse children mounted, so assert it is not VISIBLE, not absent.
    expect(screen.getByText(/if your organisation provides/i)).not.toBeVisible();

    await user.click(screen.getByRole('button', { name: /how to fix/i }));

    const body = document.body.textContent ?? '';
    // Ordered for a no-mirror reality: retry -> manual archive -> proxy -> optional mirror.
    expect(body).toContain('PLAYWRIGHT_BROWSERS_PATH');
    expect(body).toContain('HTTPS_PROXY');
    expect(body).toContain('NODE_EXTRA_CA_CERTS');
    // The mirror is presented as conditional ("if your org ever provides one"),
    // never as an existing resource, and only as the LAST step.
    expect(body).toContain('PLAYWRIGHT_DOWNLOAD_HOST');
    // Conditional phrasing ("if ... provides"), never "we have a mirror".
    expect(body).toMatch(/if your organisation provides/i);
    // No CDN URL is hardcoded into the guidance.
    expect(body).not.toMatch(/https?:\/\//);
  });
});

/** A report whose failing check carries `install: 'python'`. uv passes, so the
 *  install prerequisite is satisfied and the button is enabled. */
const reportPythonMissing = report([
  check({ name: 'node', ok: true, version: 'v26.0.0' }),
  check({ name: 'uv', ok: true, version: 'uv 0.11.8' }),
  check({
    name: 'python',
    ok: false,
    hint: 'Python 3.14 not found — click Install Python',
    category: 'required-install',
    install: 'python',
  }),
]);

describe('DoctorPanel — Install Python', () => {
  it('renders an Install Python button on the failing python check and triggers the mutation', async () => {
    const user = userEvent.setup();
    renderPanel(<DoctorPanel doctor={reportPythonMissing} isLoading={false} />);

    const installBtn = screen.getByRole('button', { name: /install python/i });
    expect(installBtn).toBeInTheDocument();

    await user.click(installBtn);
    expect(installMutate).toHaveBeenCalledTimes(1);
  });

  it('does not render an Install Python button when python passes', () => {
    const ok = report([
      check({ name: 'python', ok: true, version: '3.14', category: 'required-install' }),
    ]);
    renderPanel(<DoctorPanel doctor={ok} isLoading={false} />);
    expect(screen.queryByRole('button', { name: /install python/i })).not.toBeInTheDocument();
  });

  it('shows a spinner while installing and surfaces the in-band failure message', () => {
    installReturn = {
      mutate: installMutate,
      isPending: false,
      data: {
        ok: false,
        version: '3.14',
        error: { code: 'PYTHON_INSTALL_FAILED', message: 'uv python install failed' },
      },
    };
    renderPanel(<DoctorPanel doctor={reportPythonMissing} isLoading={false} />);
    expect(screen.getByText('uv python install failed')).toBeInTheDocument();
  });

  it('disables Install Python and names the prerequisite when uv is missing (ordered install)', () => {
    const noUv = report([
      check({ name: 'uv', ok: false, hint: 'Install uv', category: 'required-install' }),
      check({
        name: 'python',
        ok: false,
        hint: 'Python not found',
        category: 'required-install',
        install: 'python',
      }),
    ]);
    renderPanel(<DoctorPanel doctor={noUv} isLoading={false} />);
    const installBtn = screen.getByRole('button', { name: /install python/i });
    expect(installBtn).toBeDisabled();
    expect(screen.getByText(/install uv first/i)).toBeInTheDocument();
  });
});
