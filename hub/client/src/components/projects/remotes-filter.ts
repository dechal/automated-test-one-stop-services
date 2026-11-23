import type { RepoRemotes } from '@hub/shared';

export function remotesRepoId(tool: string, type: string, name: string): string {
  return `tools/${tool}/projects/${type}/${name}`;
}

export function filterRepos(repos: readonly RepoRemotes[], query: string): RepoRemotes[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...repos];
  return repos.filter(
    (repo) =>
      repo.id.toLowerCase().includes(q) ||
      repo.label.toLowerCase().includes(q) ||
      repo.remotes.some(
        (remote) => remote.name.toLowerCase().includes(q) || remote.url.toLowerCase().includes(q),
      ),
  );
}
