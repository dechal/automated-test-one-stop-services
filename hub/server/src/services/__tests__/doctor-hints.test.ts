import { describe, expect, it } from 'vitest';
import { dockerStartHint } from '../doctor.js';

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
