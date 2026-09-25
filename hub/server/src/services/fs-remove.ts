import fs from 'node:fs';

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 100;

export interface RemoveDirOptions {
  maxRetries?: number;
  retryDelayMs?: number;
}

export function removeDirWithRetry(dir: string, options: RemoveDirOptions = {}): void {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  fs.rmSync(dir, { recursive: true, force: true, maxRetries, retryDelay });
}
