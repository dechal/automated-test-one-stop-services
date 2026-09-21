// scripts/manifests/__tests__/validate.spec.ts
//
// Unit tests for `scripts/manifests/validate.ts`.
// Covers every documented rejection path of `validateManifest()` and the
// cross-manifest invariants of `validateRegistry()`. Each rejection asserts the
// matching `ManifestError.code`.
import { describe, expect, it } from 'vitest';
import type { ManifestError, ToolManifestRecord } from '../types.js';
import { validateManifest, validateRegistry } from '../validate.js';
import { baseManifest, readFixture } from './_helpers.js';

/** Build an "ok" registry record from a known-valid manifest JSON object. */
function okRecord(json: Record<string, unknown>, folderId?: string): ToolManifestRecord {
  const res = validateManifest(json);
  if (!res.ok) {
    throw new Error(`fixture expected to be valid but failed: ${JSON.stringify(res.errors)}`);
  }
  const folder = folderId ?? (json.id as string);
  return {
    path: `/ws/tools/${folder}/tool.manifest.json`,
    status: 'ok',
    manifest: res.manifest,
    errors: [],
  };
}

function codesOf(errors: readonly ManifestError[]): string[] {
  return errors.map((e) => e.code);
}

function manifestWith(id: string, alias: string, namespace: string): Record<string, unknown> {
  const m = baseManifest();
  m.id = id;
  m.alias = alias;
  (m.runner as Record<string, unknown>).taskNamespace = namespace;
  return m;
}

describe('validateManifest — accepts well-formed manifests', () => {
  it('accepts the minimal valid fixture and returns a typed manifest', () => {
    const res = validateManifest(baseManifest());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.manifest.id).toBe('cypress');
      expect(res.manifest.alias).toBe('cy');
      expect(res.manifest.runner.taskNamespace).toBe('cy');
    }
  });

  it('accepts a depth=1 / typeAxis=false manifest with a fixedType', () => {
    const res = validateManifest(readFixture('invalid-duplicate-alias-a.json'));
    expect(res.ok).toBe(true);
  });

  it('accepts a manifest with NO projects.display (backward compatible)', () => {
    const m = baseManifest();
    expect((m.projects as Record<string, unknown>).display).toBeUndefined();
    const res = validateManifest(m);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.manifest.projects.display).toBeUndefined();
    }
  });

  it('accepts and preserves a valid projects.display map', () => {
    const m = baseManifest();
    (m.projects as Record<string, unknown>).display = { web: true, api: false };
    const res = validateManifest(m);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.manifest.projects.display).toEqual({ web: true, api: false });
    }
  });
});

describe('validateManifest — schema rejection paths', () => {
  // Each case mutates a fresh valid manifest into a single invalid state and
  // asserts the structured failure carries the SCHEMA_FAIL code.
  const cases: { name: string; mutate: (m: Record<string, unknown>) => void }[] = [
    {
      name: 'schemaVersion not "1" (1.2)',
      mutate: (m) => {
        m.schemaVersion = '2';
      },
    },
    {
      name: 'id violates regex (1.3)',
      mutate: (m) => {
        m.id = 'Bad_Id';
      },
    },
    {
      name: 'id missing entirely (1.3)',
      mutate: (m) => {
        delete m.id;
      },
    },
    {
      name: 'alias violates regex (1.5)',
      mutate: (m) => {
        m.alias = 'Bad-Alias';
      },
    },
    {
      name: 'runtime not in enum (1.10)',
      mutate: (m) => {
        m.runtime = 'ruby';
      },
    },
    {
      name: 'packageManager not in enum (1.11)',
      mutate: (m) => {
        m.packageManager = 'npm';
      },
    },
    {
      name: 'projects.depth not 1 or 2 (1.12)',
      mutate: (m) => {
        (m.projects as Record<string, unknown>).depth = 3;
      },
    },
    {
      name: 'projects.display value not a boolean',
      mutate: (m) => {
        (m.projects as Record<string, unknown>).display = { web: 'yes' };
      },
    },
    {
      name: 'typeAxis=false without fixedType (1.13)',
      mutate: (m) => {
        const p = m.projects as Record<string, unknown>;
        p.typeAxis = false;
        p.fixedType = null;
      },
    },
    {
      name: 'compose.networks element violates regex (1.14)',
      mutate: (m) => {
        (m.compose as Record<string, unknown>).networks = ['Bad_Net'];
      },
    },
    {
      name: 'runner.taskNamespace violates regex (1.7)',
      mutate: (m) => {
        (m.runner as Record<string, unknown>).taskNamespace = 'Bad_NS';
      },
    },
    {
      name: 'duplicate runner.steps[].id (1.9)',
      mutate: (m) => {
        const runner = m.runner as Record<string, unknown>;
        runner.steps = [
          { id: 'dup', kind: 'text', title: 'a', passAs: { kind: 'none' } },
          { id: 'dup', kind: 'text', title: 'b', passAs: { kind: 'none' } },
        ];
      },
    },
    {
      name: 'passAs.task key violates KEY regex',
      mutate: (m) => {
        const runner = m.runner as Record<string, unknown>;
        runner.steps = [
          { id: 's1', kind: 'text', title: 'x', passAs: { kind: 'task', key: 'lower' } },
        ];
      },
    },
  ];

  for (const c of cases) {
    it(`rejects: ${c.name}`, () => {
      const m = baseManifest();
      c.mutate(m);
      const res = validateManifest(m);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.length).toBeGreaterThan(0);
        expect(res.errors.every((e) => e.code === 'SCHEMA_FAIL')).toBe(true);
      }
    });
  }
});

describe('validateManifest — never throws on arbitrary input', () => {
  const weird: unknown[] = [
    null,
    undefined,
    0,
    42,
    'a string',
    true,
    [],
    [1, 2, 3],
    {},
    { partially: 'valid', schemaVersion: '1' },
    Number.NaN,
    Symbol('x'),
  ];

  for (const input of weird) {
    it(`returns a structured result for: ${String(typeof input)}`, () => {
      const res = validateManifest(input);
      // Either ok, or a failure carrying at least one specific error code.
      const sound = res.ok === true || (!res.ok && res.errors.length > 0);
      expect(sound).toBe(true);
      if (!res.ok) {
        expect(typeof res.errors[0].code).toBe('string');
      }
    });
  }
});

describe('validateRegistry — folder-vs-id match', () => {
  it('flags FOLDER_ID_MISMATCH when manifest.id !== containing folder', () => {
    const record = okRecord(baseManifest(), 'not-cypress');
    const [out] = validateRegistry([record]);
    expect(out.status).toBe('invalid');
    expect(codesOf(out.errors)).toContain('FOLDER_ID_MISMATCH');
  });

  it('leaves a matching folder/id record untouched', () => {
    const record = okRecord(baseManifest()); // folder defaults to id 'cypress'
    const [out] = validateRegistry([record]);
    expect(out.status).toBe('ok');
    expect(out.errors).toHaveLength(0);
  });
});

describe('validateRegistry — alias uniqueness', () => {
  it('marks BOTH enabled manifests sharing an alias with DUPLICATE_ALIAS', () => {
    const a = okRecord(readFixture('invalid-duplicate-alias-a.json') as Record<string, unknown>);
    const b = okRecord(readFixture('invalid-duplicate-alias-b.json') as Record<string, unknown>);
    const out = validateRegistry([a, b]);
    expect(out).toHaveLength(2);
    for (const r of out) {
      expect(r.status).toBe('invalid');
      expect(codesOf(r.errors)).toContain('DUPLICATE_ALIAS');
    }
  });

  it('does not flag a shared alias when one of the tools is disabled', () => {
    const aJson = readFixture('invalid-duplicate-alias-a.json') as Record<string, unknown>;
    const bJson = readFixture('invalid-duplicate-alias-b.json') as Record<string, unknown>;
    bJson.enabled = false;
    const out = validateRegistry([okRecord(aJson), okRecord(bJson)]);
    for (const r of out) {
      expect(codesOf(r.errors)).not.toContain('DUPLICATE_ALIAS');
    }
  });
});

describe('validateRegistry — namespace uniqueness', () => {
  it('marks BOTH enabled manifests sharing a taskNamespace with DUPLICATE_NAMESPACE', () => {
    const a = okRecord(manifestWith('toola', 'ta', 'shared'));
    const b = okRecord(manifestWith('toolb', 'tb', 'shared'));
    const out = validateRegistry([a, b]);
    for (const r of out) {
      expect(r.status).toBe('invalid');
      expect(codesOf(r.errors)).toContain('DUPLICATE_NAMESPACE');
    }
  });

  it('does not flag distinct namespaces', () => {
    const a = okRecord(manifestWith('toola', 'ta', 'nsa'));
    const b = okRecord(manifestWith('toolb', 'tb', 'nsb'));
    const out = validateRegistry([a, b]);
    for (const r of out) {
      expect(r.status).toBe('ok');
      expect(r.errors).toHaveLength(0);
    }
  });
});

describe('validateRegistry — pass-through and immutability', () => {
  it('passes already-invalid records through untouched', () => {
    const broken: ToolManifestRecord = {
      path: '/ws/tools/broken/tool.manifest.json',
      status: 'invalid',
      manifest: null,
      errors: [{ code: 'SCHEMA_FAIL', message: 'pre-existing' }],
    };
    const [out] = validateRegistry([broken]);
    expect(out).toEqual(broken);
  });

  it('does not mutate the input array or records', () => {
    const record = okRecord(baseManifest(), 'wrong-folder');
    const input = [record];
    const snapshot = JSON.parse(JSON.stringify(input)) as ToolManifestRecord[];
    validateRegistry(input);
    expect(input).toEqual(snapshot);
  });

  it('returns identical results regardless of record order (order-independence)', () => {
    const a = okRecord(manifestWith('toola', 'ta', 'shared'));
    const b = okRecord(manifestWith('toolb', 'tb', 'shared'));
    const forward = validateRegistry([a, b]).map((r) => r.status);
    const reversed = validateRegistry([b, a]).map((r) => r.status);
    expect(forward).toEqual(reversed);
  });
});
