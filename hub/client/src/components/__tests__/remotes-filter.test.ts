import type { RepoRemotes } from '@hub/shared';
import { describe, expect, it } from 'vitest';
import { filterRepos, remotesRepoId } from '../projects/remotes-filter.js';

const repos: RepoRemotes[] = [
  {
    id: 'tools/k6',
    label: 'k6',
    kind: 'tool',
    remotes: [{ name: 'origin', url: 'https://example.com/team/k6.git' }],
  },
  {
    id: 'brain/projects/b1',
    label: 'b1',
    kind: 'brain',
    remotes: [
      { name: 'origin', url: 'git@example.org:team/brain.git' },
      { name: 'personal', url: 'https://***@example.net/me/brain.git' },
    ],
  },
];

describe('filterRepos', () => {
  it('returns every repo for an empty query', () => {
    expect(filterRepos(repos, '  ')).toHaveLength(2);
  });

  it('matches by repo id or label', () => {
    expect(filterRepos(repos, 'BRAIN/projects').map((r) => r.id)).toEqual(['brain/projects/b1']);
    expect(filterRepos(repos, 'k6').map((r) => r.id)).toEqual(['tools/k6']);
  });

  it('matches by remote name', () => {
    expect(filterRepos(repos, 'personal').map((r) => r.id)).toEqual(['brain/projects/b1']);
  });

  it('matches by masked url', () => {
    expect(filterRepos(repos, 'example.net').map((r) => r.id)).toEqual(['brain/projects/b1']);
  });

  it('returns nothing when no field matches', () => {
    expect(filterRepos(repos, 'zzz')).toEqual([]);
  });
});

describe('remotesRepoId', () => {
  it('builds the project repo id', () => {
    expect(remotesRepoId('playwright', 'web', 'p1')).toBe('tools/playwright/projects/web/p1');
  });
});
