/**
 * Poll /api/health until it succeeds or timeout. Used during system update
 * to detect when the server is back online after a Hub restart.
 */
export async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (res.ok) return true;
    } catch {
      // server still down; ignore
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}
