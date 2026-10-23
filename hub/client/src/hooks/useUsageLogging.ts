import type { UsageLoggingStatus } from '@hub/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '~/api/client.js';
import { qUsageLogging, queryRoots } from '~/api/queries.js';

export type { UsageLoggingStatus };

export function useUsageLogging() {
  return useQuery(qUsageLogging());
}

/**
 * Run the interactive Google OAuth flow (POST /api/usage-logging/authenticate).
 * Opens a browser on the machine running the Hub (local-only) and writes
 * token.json; on success the server auto-enables logging when fully ready.
 */
export function useAuthenticateGoogle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<UsageLoggingStatus>('/api/usage-logging/authenticate', {}),
    onSuccess: () => {
      // Auth can flip FORCE_TRACK + creates token.json — refresh everything
      // derived from usage-logging state (badge, credentials, scripts/.env, config).
      qc.invalidateQueries({ queryKey: [queryRoots.usageLogging] });
      qc.invalidateQueries({ queryKey: [queryRoots.credentials] });
      qc.invalidateQueries({ queryKey: [queryRoots.env] });
      qc.invalidateQueries({ queryKey: [queryRoots.config] });
    },
  });
}

/** Turn usage logging on/off (POST /api/usage-logging/enabled). */
export function useSetUsageLogging() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api.post<UsageLoggingStatus>('/api/usage-logging/enabled', { enabled }),
    onSuccess: () => {
      // The toggle writes FORCE_TRACK into scripts/.env, so refresh everything
      // derived from it: this badge, the scripts/.env editor (['env', …]), and
      // the Run page's /api/config forceTrack (['config']).
      qc.invalidateQueries({ queryKey: [queryRoots.usageLogging] });
      qc.invalidateQueries({ queryKey: [queryRoots.env] });
      qc.invalidateQueries({ queryKey: [queryRoots.config] });
    },
  });
}
