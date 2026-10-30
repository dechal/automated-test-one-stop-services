// scripts/install-core/__tests__/arbitraries.ts
//
// fast-check arbitraries + a spy effects factory for the install-core property
// tests. Generators
// constrain to the relevant input space: valid/invalid SAFE_IDs and git URLs, and
// the set of requests that MUST be rejected at the `validate` stage.

import * as fc from 'fast-check';
import type { InstallEffects, InstallRequest } from '../pipeline.js';
import { SAFE_GIT_URL, SAFE_ID } from '../validation.js';

/** Valid SAFE_ID tool ids: lowercase start, then `[a-z0-9-]`, length ≥ 2. */
export const arbValidToolId: fc.Arbitrary<string> = fc.stringMatching(/^[a-z][a-z0-9-]{1,12}$/);

/**
 * Strings that FAIL SAFE_ID: known bad shapes (empty, single char, uppercase,
 * leading digit/dash/dot, traversal, whitespace, shell metacharacters) plus
 * random strings filtered to be non-matching.
 */
export const arbInvalidToolId: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    '',
    'a',
    'A',
    'Foo',
    '1tool',
    '-tool',
    '.hidden',
    '../etc',
    'a b',
    'a;rm',
    'tool/',
    'tool$x',
  ),
  fc.string().filter((s) => !SAFE_ID.test(s)),
);

/** Valid SAFE_GIT_URL values across the accepted forms. */
export const arbValidGitUrl: fc.Arbitrary<string> = fc.constantFrom(
  'https://example.com/org/repo.git',
  'https://gitlab.com/group/sub/repo.git',
  'git@github.com:org/repo.git',
  'ssh://git@host.example/org/repo.git',
);

/**
 * Strings that FAIL SAFE_GIT_URL: wrong scheme, whitespace, shell metacharacters,
 * empty, plus random strings filtered to be non-matching.
 */
export const arbInvalidGitUrl: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    '',
    'http://insecure.example/repo.git',
    'ftp://host/repo',
    'file:///etc/passwd',
    'https://exa mple.com/repo.git',
    'https://host/repo.git; rm -rf /',
    'git@host repo',
    'javascript:alert(1)',
  ),
  fc.string().filter((s) => !SAFE_GIT_URL.test(s)),
);

/** A safe ref to pair with registry sources (ref validation is out of P10 scope). */
const arbRef: fc.Arbitrary<string> = fc.constantFrom('main', 'v1.0.0', 'develop');

/**
 * Requests that MUST be rejected at the `validate` stage before ANY side effect
 * an invalid id (registry or local source), or a valid id with an
 * invalid registry git URL.
 */
export const arbRejectableRequest: fc.Arbitrary<InstallRequest> = fc.oneof(
  fc.record({
    id: arbInvalidToolId,
    source: fc.record({
      kind: fc.constant('registry' as const),
      gitUrl: arbValidGitUrl,
      ref: arbRef,
    }),
  }),
  fc.record({
    id: arbInvalidToolId,
    source: fc.constant({ kind: 'local' as const }),
  }),
  fc.record({
    id: arbValidToolId,
    source: fc.record({
      kind: fc.constant('registry' as const),
      gitUrl: arbInvalidGitUrl,
      ref: arbRef,
    }),
  }),
);

/**
 * A spy `InstallEffects` that records every call by name. Used to
 * assert ZERO side-effecting calls happen when a request is rejected at validate.
 */
export function makeSpyEffects(): { effects: InstallEffects; calls: string[] } {
  const calls: string[] = [];
  const effects: InstallEffects = {
    cloneRegistry: (input) => {
      calls.push(`cloneRegistry:${input.id}`);
    },
    gatherFacts: (id) => {
      calls.push(`gatherFacts:${id}`);
      return { id, hasPackageJson: false, isUvTool: false, hasSetupTask: false };
    },
    installDeps: (input) => {
      calls.push(`installDeps:${input.manager}`);
    },
    runSetup: (input) => {
      calls.push(`runSetup:${input.id}`);
      return { id: input.id, exitCode: 0 };
    },
  };
  return { effects, calls };
}
