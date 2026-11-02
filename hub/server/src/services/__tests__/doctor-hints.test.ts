import { describe, expect, it } from 'vitest';
import { checkComposeService, dockerStartHint } from '../doctor.js';

describe('checkComposeService', () => {
  it('names Docker as the blocker when the daemon is down', async () => {
    const check = await checkComposeService('influxdb', 8086, false);
    expect(check).toMatchObject({ name: 'influxdb', ok: false, category: 'optional-process' });
    expect(check.hint).toContain('start Docker first');
  });
});

describe('dockerStartHint', () => {
  it('points Windows users at Docker Desktop', () => {
    expect(dockerStartHint('win32')).toBe('Start Docker Desktop');
  });

  it('points macOS users at Docker Desktop', () => {
    expect(dockerStartHint('darwin')).toBe('Start Docker Desktop');
  });

  it('gives Linux users the systemctl command', () => {
    expect(dockerStartHint('linux')).toBe('Start the Docker daemon: sudo systemctl start docker');
  });
});
