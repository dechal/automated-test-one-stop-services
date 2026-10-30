import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_ROOT } from '../../config.js';

/**
 * Parity guard for the trust-boundary regexes that are DELIBERATELY duplicated.
 *
 * `scripts/` cannot import `hub/server` (Biome bans deep `../../` imports), the
 * server's only alias into `scripts/` is `@manifests/*` (no install-core),
 * and a few hub route/service files inline their own `SAFE_GIT_URL` copy rather
 * than importing the shared one. Every copy is meant to be byte-identical and
 * "kept in lock-step by hand" (see the note in scripts/install-core/validation.ts).
 *
 * This test turns a silent drift between those copies into a failing test. It
 * reads each file as text and extracts the regex literal instead of importing
 * across the boundary — importing is exactly what the boundary forbids, and
 * importing tool-plugins.ts would drag in its child_process side effects.
 */

const at = (rel: string) => path.join(WORKSPACE_ROOT, ...rel.split('/'));

/** Extract the source of `const NAME = /.../;` (with or without `export`). */
function regexLiteral(file: string, name: string): string {
  const text = readFileSync(file, 'utf8');
  const match = text.match(new RegExp(`^(?:export )?const ${name}\\s*=\\s*(/.*/);`, 'm'));
  const literal = match?.[1];
  if (!literal) throw new Error(`${name} regex literal not found in ${file}`);
  return literal;
}

interface ParityCase {
  name: string;
  files: string[];
}

const CASES: ParityCase[] = [
  {
    name: 'SAFE_ID',
    files: ['hub/server/src/lib/safe-id.ts', 'scripts/install-core/validation.ts'],
  },
  {
    name: 'SAFE_GIT_REF',
    files: ['hub/server/src/lib/safe-id.ts', 'scripts/install-core/validation.ts'],
  },
  {
    // Four hand-maintained copies — the highest drift risk of the three.
    name: 'SAFE_GIT_URL',
    files: ['hub/server/src/lib/safe-id.ts', 'scripts/install-core/validation.ts'],
  },
];

describe('trust-boundary regex parity', () => {
  for (const { name, files } of CASES) {
    it(`${name} is byte-identical across all ${files.length} copies`, () => {
      const sources = files.map((rel) => regexLiteral(at(rel), name));
      for (let i = 1; i < sources.length; i++) {
        expect(sources[i], `${files[i]} drifted from ${files[0]}`).toBe(sources[0]);
      }
    });
  }

  it('the extractor returns a working pattern (guards the extractor itself)', () => {
    const source = regexLiteral(at('hub/server/src/lib/safe-id.ts'), 'SAFE_ID');
    const re = new RegExp(source.slice(1, -1)); // strip the leading/trailing '/'
    expect(re.test('playwright')).toBe(true);
    expect(re.test('../evil')).toBe(false);
  });
});
