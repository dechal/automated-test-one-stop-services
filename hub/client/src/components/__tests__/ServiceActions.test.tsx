import type { DoctorCheck } from '@hub/shared';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '~/i18n/en';
import { ServiceActions } from '../ServiceActions';

const post = vi.fn();
vi.mock('~/api/client.js', () => ({ api: { post: (...args: unknown[]) => post(...args) } }));

function svc(partial: Partial<DoctorCheck> & Pick<DoctorCheck, 'name'>): DoctorCheck {
  return { ok: false, category: 'optional-process', ...partial };
}

const dockerUp = svc({ name: 'docker-running', ok: true, service: 'docker' });

function renderActions(check: DoctorCheck, allChecks: DoctorCheck[]) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <ServiceActions check={check} allChecks={allChecks} />
      </MantineProvider>
    </QueryClientProvider>,
  );
}

describe('ServiceActions', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
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
    post.mockReset();
    post.mockResolvedValue({});
  });

  it('starts a stopped compose service when Docker is up', async () => {
    const grafana = svc({ name: 'grafana', service: 'compose' });
    renderActions(grafana, [dockerUp, grafana]);
    await userEvent.click(screen.getByRole('button', { name: en['common.start'] }));
    expect(post).toHaveBeenCalledWith('/api/docker/service/start', { service: 'grafana' });
  });

  it('offers no compose action while Docker is down', () => {
    const grafana = svc({ name: 'grafana', service: 'compose' });
    renderActions(grafana, [grafana]);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers Install for Appium that is not installed', async () => {
    const appium = svc({ name: 'appium', service: 'appium', install: 'appium' });
    renderActions(appium, [appium]);
    await userEvent.click(screen.getByRole('button', { name: en['common.install'] }));
    expect(post).toHaveBeenCalledWith('/api/appium/install', undefined);
  });

  it('offers Start Docker Desktop only while the daemon is down', () => {
    const down = svc({ name: 'docker-running', service: 'docker' });
    renderActions(down, [down]);
    expect(screen.getByRole('button', { name: en['docker.startDesktop'] })).toBeTruthy();
  });
});
