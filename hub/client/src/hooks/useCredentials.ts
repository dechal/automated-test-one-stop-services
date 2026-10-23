import type { CredentialStatus } from '@hub/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '~/api/client.js';
import { qCredentials, queryRoots } from '~/api/queries.js';

export type { CredentialStatus };

/** Lists every third-party tool that declares a credentials/ folder. */
export function useCredentials() {
  return useQuery(qCredentials());
}

/** Uploads a tool's credentials.json (POST /api/credentials/:tool). */
export function useUploadCredentials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tool, content }: { tool: string; content: string }) =>
      api.post<{ success: boolean; path: string }>(`/api/credentials/${tool}`, { content }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [queryRoots.credentials] });
      // Uploading credentials changes usage-logging readiness — refresh its badge/steps.
      qc.invalidateQueries({ queryKey: [queryRoots.usageLogging] });
    },
  });
}
