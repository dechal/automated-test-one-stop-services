// scripts/manifests/__tests__/command-parity.spec.ts
//
// Anti-drift parity guard. The Hub command-builder
// (`hub/server/src/services/command-builder.ts`) delegates to the shared
// `buildRunCommandFromInput()`, which itself delegates to the canonical CLI
// builder `buildTaskCommand()`. This suite proves both code paths emit IDENTICAL
// `task …` command strings for the three built-ins across the
// local/docker × headless/headed × tag/section/perf-type matrix — so the Hub UI
// can never diverge from the interactive CLI runner.
//
// The real `tools/*/tool.manifest.json` files are loaded (not inline fixtures),
// so the test also pins the headless reconciliation: robot's runner `mode` step
// produces the full `--variable HEADLESS:…` token.
//
// Two facets are asserted per scenario:
//   1. Structural parity — `buildRunCommandFromInput(identity quote)` equals the
//      hand-written CLI `buildTaskCommand(answers)` AND an exact literal string.
//   2. Shell-quoting — with the Hub's `shellQuote`, task-var VALUES
//      (TYPE/PROJECT/TAG/SECTION/PERFORMANCE_TYPE) are single-quoted while cli
//      args (headless flag, extra args) pass through verbatim.
//
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildRunCommandFromInput,
  buildTaskCommand,
  type RunCommandInput,
  type RunnerAnswers,
} from '../runner-command.js';
import type { ToolManifest } from '../types.js';
import { validateManifest } from '../validate.js';
import { realToolsPresent } from './_helpers.js';

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

// The built-in tool repos are git-ignored and absent from a fresh clone / CI.
// Load the REAL manifests only when present; otherwise the suite is skipped
// (the conditional load keeps module import from throwing ENOENT).
const TOOLS_PRESENT = realToolsPresent(WORKSPACE_ROOT, ['playwright', 'robot-framework', 'k6']);

function loadManifest(id: string): ToolManifest {
  const raw = fs.readFileSync(path.join(WORKSPACE_ROOT, 'tools', id, 'tool.manifest.json'), 'utf8');
  const res = validateManifest(JSON.parse(raw));
  if (!res.ok) {
    throw new Error(`invalid ${id} manifest: ${JSON.stringify(res.errors)}`);
  }
  return res.manifest;
}

const empty = {} as ToolManifest;
const playwright = TOOLS_PRESENT ? loadManifest('playwright') : empty;
const robot = TOOLS_PRESENT ? loadManifest('robot-framework') : empty;
const k6 = TOOLS_PRESENT ? loadManifest('k6') : empty;

/** Identity quote — the canonical structural form (matches the CLI runner). */
const identity = (v: string): string => v;
/** The Hub's shell quoter — single-quotes values for safe shell pass-through. */
const shellQuote = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;

type HubSpec = Omit<RunCommandInput, 'quote'>;

interface Scenario {
  readonly name: string;
  readonly manifest: ToolManifest;
  readonly hub: HubSpec;
  /** The hand-written CLI answers representing the SAME run (identity values). */
  readonly cliAnswers: RunnerAnswers;
  /** Exact command string both paths must emit with the identity quote. */
  readonly expected: string;
  /** Exact command string the Hub emits with its `shellQuote`. */
  readonly expectedQuoted: string;
}

const scenarios: Scenario[] = [
  // ── Playwright ────────────────────────────────────────────────────────────
  {
    name: 'playwright local headed + tag(regex) + extra args',
    manifest: playwright,
    hub: {
      mode: 'local',
      type: 'web',
      project: 'ecom',
      tag: '(?=.*@TEST-C001)',
      headless: false,
      extraArgs: '--workers=1',
    },
    cliAnswers: {
      executionType: 'run',
      environment: 'local',
      type: 'web',
      project: 'ecom',
      tag: '(?=.*@TEST-C001)',
      mode: '--headed',
      args: '--workers=1',
    },
    expected:
      'task pw:run-local TYPE=web PROJECT=ecom TAG=(?=.*@TEST-C001) -- --headed --workers=1',
    expectedQuoted:
      "task pw:run-local TYPE='web' PROJECT='ecom' TAG='(?=.*@TEST-C001)' -- --headed '--workers=1'",
  },
  {
    name: 'playwright local headless — no headless token',
    manifest: playwright,
    hub: { mode: 'local', type: 'api', project: 'payments', headless: true },
    cliAnswers: { executionType: 'run', environment: 'local', type: 'api', project: 'payments' },
    expected: 'task pw:run-local TYPE=api PROJECT=payments',
    expectedQuoted: "task pw:run-local TYPE='api' PROJECT='payments'",
  },
  {
    name: 'playwright local unspecified headless — no token',
    manifest: playwright,
    hub: { mode: 'local', type: 'web', project: 'shop' },
    cliAnswers: { executionType: 'run', environment: 'local', type: 'web', project: 'shop' },
    expected: 'task pw:run-local TYPE=web PROJECT=shop',
    expectedQuoted: "task pw:run-local TYPE='web' PROJECT='shop'",
  },
  {
    name: 'playwright docker + tag (headless forced to none by dockerOverride)',
    manifest: playwright,
    hub: { mode: 'docker', type: 'web', project: 'ecom', tag: '@smoke', headless: false },
    cliAnswers: {
      executionType: 'run',
      environment: 'docker',
      type: 'web',
      project: 'ecom',
      tag: '@smoke',
    },
    expected: 'task pw:run-docker TYPE=web PROJECT=ecom TAG=@smoke',
    expectedQuoted: "task pw:run-docker TYPE='web' PROJECT='ecom' TAG='@smoke'",
  },
  // ── Robot Framework ─────────────────────────────────────────────────────────
  {
    name: 'robot local headless + tag',
    manifest: robot,
    hub: { mode: 'local', type: 'web', project: 'checkout', tag: '@smoke', headless: true },
    cliAnswers: {
      executionType: 'run',
      environment: 'local',
      type: 'web',
      project: 'checkout',
      tag: '@smoke',
      mode: '--variable HEADLESS:True',
    },
    expected:
      'task robot:run-local TYPE=web PROJECT=checkout TAG=@smoke -- --variable HEADLESS:True',
    expectedQuoted:
      "task robot:run-local TYPE='web' PROJECT='checkout' TAG='@smoke' -- --variable HEADLESS:True",
  },
  {
    name: 'robot local headed + extra args',
    manifest: robot,
    hub: {
      mode: 'local',
      type: 'desktop',
      project: 'crm',
      headless: false,
      extraArgs: '--loglevel DEBUG',
    },
    cliAnswers: {
      executionType: 'run',
      environment: 'local',
      type: 'desktop',
      project: 'crm',
      mode: '--variable HEADLESS:False',
      args: '--loglevel DEBUG',
    },
    expected:
      'task robot:run-local TYPE=desktop PROJECT=crm -- --variable HEADLESS:False --loglevel DEBUG',
    expectedQuoted:
      "task robot:run-local TYPE='desktop' PROJECT='crm' -- --variable HEADLESS:False '--loglevel' 'DEBUG'",
  },
  {
    name: 'robot docker + tag (headless forced True by dockerOverride)',
    manifest: robot,
    hub: { mode: 'docker', type: 'web', project: 'checkout', tag: '@regression', headless: false },
    cliAnswers: {
      executionType: 'run',
      environment: 'docker',
      type: 'web',
      project: 'checkout',
      tag: '@regression',
    },
    expected:
      'task robot:run-docker TYPE=web PROJECT=checkout TAG=@regression -- --variable HEADLESS:True',
    expectedQuoted:
      "task robot:run-docker TYPE='web' PROJECT='checkout' TAG='@regression' -- --variable HEADLESS:True",
  },
  // ── k6 ──────────────────────────────────────────────────────────────────────
  {
    name: 'k6 local section + performance type',
    manifest: k6,
    hub: { mode: 'local', project: 'billing', section: 'auth', performanceType: 'LOAD' },
    cliAnswers: {
      executionType: 'run',
      environment: 'local',
      project: 'billing',
      section: 'auth',
      performance_type: 'LOAD',
    },
    expected: 'task k6:run-local PROJECT=billing SECTION=auth PERFORMANCE_TYPE=LOAD',
    expectedQuoted: "task k6:run-local PROJECT='billing' SECTION='auth' PERFORMANCE_TYPE='LOAD'",
  },
  {
    name: 'k6 docker section + performance type',
    manifest: k6,
    hub: { mode: 'docker', project: 'billing', section: 'checkout', performanceType: 'STRESS' },
    cliAnswers: {
      executionType: 'run',
      environment: 'docker',
      project: 'billing',
      section: 'checkout',
      performance_type: 'STRESS',
    },
    expected: 'task k6:run-docker PROJECT=billing SECTION=checkout PERFORMANCE_TYPE=STRESS',
    expectedQuoted:
      "task k6:run-docker PROJECT='billing' SECTION='checkout' PERFORMANCE_TYPE='STRESS'",
  },
];

describe.skipIf(!TOOLS_PRESENT)(
  'command parity — Hub (buildRunCommandFromInput) ≡ CLI (buildTaskCommand)',
  () => {
    for (const s of scenarios) {
      it(`${s.name}: identity-quote Hub output equals the CLI builder and the canonical literal`, () => {
        const cli = buildTaskCommand(s.manifest, s.cliAnswers);
        const hub = buildRunCommandFromInput(s.manifest, { ...s.hub, quote: identity });
        // The Hub's delegation target reproduces the CLI builder byte-for-byte…
        expect(hub).toBe(cli);
        // …and both match the pinned canonical command string (anti-drift).
        expect(hub).toBe(s.expected);
      });

      it(`${s.name}: shell-quoted Hub output quotes task-var values + extra-arg words`, () => {
        const hub = buildRunCommandFromInput(s.manifest, { ...s.hub, quote: shellQuote });
        expect(hub).toBe(s.expectedQuoted);
      });
    }
  },
);
