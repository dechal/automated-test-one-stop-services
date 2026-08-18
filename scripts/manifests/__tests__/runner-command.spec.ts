// scripts/manifests/__tests__/runner-command.spec.ts
//
// Unit tests for the runner command builder.
// Validates that `buildTaskCommand` produces the same command semantics as the
// legacy `scripts/runner.ts` for every interactive flow: Playwright run+tags,
// Robot Framework run+tags, k6 run (local/docker).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildTaskCommand,
  matchesWhen,
  quoteExtraArgs,
  type RunnerAnswers,
  resolveValue,
  substitute,
} from '../runner-command.js';
import type { ToolManifest, ToolRunnerStep, ToolRunnerWhen } from '../types.js';
import { realToolsPresent } from './_helpers.js';

// ---------------------------------------------------------------------------
// Load manifests from the actual committed tool.manifest.json files.
// This ensures the tests track the live schema — any manifest change that
// breaks command construction is caught here. The built-in tool repos are
// git-ignored and absent from a fresh clone / CI, so the manifest-driven
// describes below are skipped when they are not present (the pure substitute /
// matchesWhen / resolveValue suites still run — they need no manifest).
// ---------------------------------------------------------------------------

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

const TOOLS_PRESENT = realToolsPresent(WORKSPACE_ROOT, ['playwright', 'robot-framework', 'k6']);

function loadManifest(toolId: string): ToolManifest {
  const manifestPath = path.join(WORKSPACE_ROOT, 'tools', toolId, 'tool.manifest.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ToolManifest;
}

const empty = {} as ToolManifest;
const pw = TOOLS_PRESENT ? loadManifest('playwright') : empty;
const robot = TOOLS_PRESENT ? loadManifest('robot-framework') : empty;
const k6 = TOOLS_PRESENT ? loadManifest('k6') : empty;

// ---------------------------------------------------------------------------
// substitute()
// ---------------------------------------------------------------------------

describe('substitute', () => {
  it('replaces known tokens', () => {
    expect(substitute('{ns}:run-{environment}', { ns: 'pw', environment: 'local' })).toBe(
      'pw:run-local',
    );
  });

  it('collapses unknown tokens to empty string', () => {
    expect(substitute('{ns}:{missing}', { ns: 'k6' })).toBe('k6:');
  });

  it('handles templates with no tokens', () => {
    expect(substitute('literal', { ns: 'pw' })).toBe('literal');
  });
});

// ---------------------------------------------------------------------------
// matchesWhen()
// ---------------------------------------------------------------------------

describe('matchesWhen', () => {
  const answers: RunnerAnswers = {
    executionType: 'run',
    environment: 'local',
    type: 'web',
  };

  it('returns true when all string predicates match', () => {
    const when: ToolRunnerWhen = { executionType: 'run', environment: 'local' };
    expect(matchesWhen(when, answers)).toBe(true);
  });

  it('returns false when a string predicate does not match', () => {
    const when: ToolRunnerWhen = { executionType: 'tags' };
    expect(matchesWhen(when, answers)).toBe(false);
  });

  it('supports $ne — returns true when value differs', () => {
    const when: ToolRunnerWhen = { executionType: { $ne: 'tags' } };
    expect(matchesWhen(when, answers)).toBe(true);
  });

  it('supports $ne — returns false when value equals', () => {
    const when: ToolRunnerWhen = { executionType: { $ne: 'run' } };
    expect(matchesWhen(when, answers)).toBe(false);
  });

  it('supports $in — returns true when value is in list', () => {
    const when: ToolRunnerWhen = { environment: { $in: ['local', 'docker'] } };
    expect(matchesWhen(when, answers)).toBe(true);
  });

  it('supports $in — returns false when value is not in list', () => {
    const when: ToolRunnerWhen = { environment: { $in: ['docker'] } };
    expect(matchesWhen(when, answers)).toBe(false);
  });

  it('returns true for an empty when object (vacuously true)', () => {
    expect(matchesWhen({} as ToolRunnerWhen, answers)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveValue()
// ---------------------------------------------------------------------------

describe('resolveValue', () => {
  const baseStep: ToolRunnerStep = {
    id: 'mode',
    kind: 'select',
    title: 'Mode:',
    choices: [],
    passAs: { kind: 'cli' },
    dockerOverride: '--variable HEADLESS:True',
  };

  it('returns the answer value in non-docker environment', () => {
    const answers: RunnerAnswers = { executionType: 'run', environment: 'local', mode: '--headed' };
    expect(resolveValue(baseStep, answers)).toBe('--headed');
  });

  it('returns dockerOverride in docker environment', () => {
    const answers: RunnerAnswers = {
      executionType: 'run',
      environment: 'docker',
      mode: '--headed',
    };
    expect(resolveValue(baseStep, answers)).toBe('--variable HEADLESS:True');
  });

  it('returns empty string when answer is missing and not docker', () => {
    const answers: RunnerAnswers = { executionType: 'run', environment: 'local' };
    expect(resolveValue(baseStep, answers)).toBe('');
  });

  it('returns empty string for step without dockerOverride even in docker', () => {
    const stepWithout: ToolRunnerStep = {
      id: 'args',
      kind: 'text',
      title: 'Args:',
      passAs: { kind: 'cli' },
    };
    const answers: RunnerAnswers = { executionType: 'run', environment: 'docker' };
    expect(resolveValue(stepWithout, answers)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildTaskCommand — Playwright
// ---------------------------------------------------------------------------

describe.skipIf(!TOOLS_PRESENT)('buildTaskCommand — Playwright', () => {
  it('run (local, headed, with tag and args)', () => {
    const answers: RunnerAnswers = {
      executionType: 'run',
      environment: 'local',
      type: 'web',
      project: 'ecom',
      tag: '(?=.*@TEST-C001)',
      mode: '--headed',
      args: '--workers=1',
    };
    const cmd = buildTaskCommand(pw, answers);
    expect(cmd).toBe(
      'task pw:run-local TYPE=web PROJECT=ecom TAG=(?=.*@TEST-C001) -- --headed --workers=1',
    );
  });

  it('run (local, headless, no tag, no extra args)', () => {
    const answers: RunnerAnswers = {
      executionType: 'run',
      environment: 'local',
      type: 'api',
      project: 'payments',
      tag: '',
      mode: '',
      args: '',
    };
    const cmd = buildTaskCommand(pw, answers);
    // Empty values are dropped — no TAG, no cli part
    expect(cmd).toBe('task pw:run-local TYPE=api PROJECT=payments');
  });

  it('run (docker) — mode dockerOverride is empty, no cli section', () => {
    const answers: RunnerAnswers = {
      executionType: 'run',
      environment: 'docker',
      type: 'web',
      project: 'ecom',
      tag: '@smoke',
      mode: '--headed', // user chose headed locally but dockerOverride overrides
      args: '',
    };
    const cmd = buildTaskCommand(pw, answers);
    // dockerOverride for mode is '' → dropped. args is '' → dropped. No -- section.
    expect(cmd).toBe('task pw:run-docker TYPE=web PROJECT=ecom TAG=@smoke');
  });

  it('tags — simplified command with no tag/mode/args steps', () => {
    const answers: RunnerAnswers = {
      executionType: 'tags',
      environment: 'local',
      type: 'web',
      project: 'ecom',
    };
    const cmd = buildTaskCommand(pw, answers);
    expect(cmd).toBe('task pw:tags TYPE=web PROJECT=ecom');
  });
});

// ---------------------------------------------------------------------------
// buildTaskCommand — Robot Framework
// ---------------------------------------------------------------------------

describe.skipIf(!TOOLS_PRESENT)('buildTaskCommand — Robot Framework', () => {
  it('run (local, headless, with tag)', () => {
    const answers: RunnerAnswers = {
      executionType: 'run',
      environment: 'local',
      type: 'web',
      project: 'checkout',
      tag: '@smoke',
      mode: '--variable HEADLESS:True',
      args: '',
    };
    const cmd = buildTaskCommand(robot, answers);
    expect(cmd).toBe(
      'task robot:run-local TYPE=web PROJECT=checkout TAG=@smoke -- --variable HEADLESS:True',
    );
  });

  it('run (local, headed, with extra args)', () => {
    const answers: RunnerAnswers = {
      executionType: 'run',
      environment: 'local',
      type: 'desktop',
      project: 'crm',
      tag: '',
      mode: '--variable HEADLESS:False',
      args: '--loglevel DEBUG',
    };
    const cmd = buildTaskCommand(robot, answers);
    expect(cmd).toBe(
      'task robot:run-local TYPE=desktop PROJECT=crm -- --variable HEADLESS:False --loglevel DEBUG',
    );
  });

  it('run (docker) — forced headless via dockerOverride', () => {
    const answers: RunnerAnswers = {
      executionType: 'run',
      environment: 'docker',
      type: 'web',
      project: 'checkout',
      tag: '@regression',
      mode: '--variable HEADLESS:False', // user local choice is ignored in docker
      args: '',
    };
    const cmd = buildTaskCommand(robot, answers);
    // dockerOverride = '--variable HEADLESS:True' is applied for mode step
    expect(cmd).toBe(
      'task robot:run-docker TYPE=web PROJECT=checkout TAG=@regression -- --variable HEADLESS:True',
    );
  });

  it('tags — no tag/mode/args in output', () => {
    const answers: RunnerAnswers = {
      executionType: 'tags',
      environment: 'local',
      type: 'api',
      project: 'gateway',
    };
    const cmd = buildTaskCommand(robot, answers);
    expect(cmd).toBe('task robot:tags TYPE=api PROJECT=gateway');
  });
});

// ---------------------------------------------------------------------------
// buildTaskCommand — k6
// ---------------------------------------------------------------------------

describe.skipIf(!TOOLS_PRESENT)('buildTaskCommand — k6', () => {
  it('run (local)', () => {
    const answers: RunnerAnswers = {
      executionType: 'run',
      environment: 'local',
      project: 'billing',
      section: 'auth',
      performance_type: 'LOAD',
    };
    const cmd = buildTaskCommand(k6, answers);
    expect(cmd).toBe('task k6:run-local PROJECT=billing SECTION=auth PERFORMANCE_TYPE=LOAD');
  });

  it('run (docker)', () => {
    const answers: RunnerAnswers = {
      executionType: 'run',
      environment: 'docker',
      project: 'billing',
      section: 'checkout',
      performance_type: 'STRESS',
    };
    const cmd = buildTaskCommand(k6, answers);
    expect(cmd).toBe('task k6:run-docker PROJECT=billing SECTION=checkout PERFORMANCE_TYPE=STRESS');
  });

  it('run (docker) with INFLUX — extra answer keys are ignored (not a manifest step)', () => {
    // INFLUX=on is a manual task arg documented in pipeline.runCommands but not
    // prompted by the interactive runner. buildTaskCommand only processes
    // declared manifest steps. This verifies extra keys are harmlessly ignored.
    const answers: RunnerAnswers = {
      executionType: 'run',
      environment: 'docker',
      project: 'billing',
      section: 'auth',
      performance_type: 'LOAD',
      INFLUX: 'on',
    };
    const cmd = buildTaskCommand(k6, answers);
    expect(cmd).toBe('task k6:run-docker PROJECT=billing SECTION=auth PERFORMANCE_TYPE=LOAD');
  });

  it('run (local) with TEST_PROTOCOL type', () => {
    const answers: RunnerAnswers = {
      executionType: 'run',
      environment: 'local',
      project: 'payments',
      section: 'orders',
      performance_type: 'TEST_PROTOCOL',
    };
    const cmd = buildTaskCommand(k6, answers);
    expect(cmd).toBe(
      'task k6:run-local PROJECT=payments SECTION=orders PERFORMANCE_TYPE=TEST_PROTOCOL',
    );
  });
});

// ---------------------------------------------------------------------------
// buildTaskCommand — edge cases
// ---------------------------------------------------------------------------

describe.skipIf(!TOOLS_PRESENT)('buildTaskCommand — edge cases', () => {
  it('empty answers for optional steps produce a clean command without trailing spaces', () => {
    const answers: RunnerAnswers = {
      executionType: 'run',
      environment: 'local',
      type: 'web',
      project: 'test',
      tag: '',
      mode: '',
      args: '',
    };
    const cmd = buildTaskCommand(pw, answers);
    // No trailing space, no dangling ' -- '
    expect(cmd).toBe('task pw:run-local TYPE=web PROJECT=test');
    expect(cmd).not.toContain('  ');
    expect(cmd).not.toMatch(/\s$/);
  });

  it('falls back to top-level commandTemplate when executionType is unknown', () => {
    const answers: RunnerAnswers = {
      executionType: 'custom',
      environment: 'local',
      type: 'web',
      project: 'test',
    };
    const cmd = buildTaskCommand(pw, answers);
    // Falls back to `task {ns}:{executionType}-{environment}` → `task pw:custom-local`
    expect(cmd).toBe('task pw:custom-local TYPE=web PROJECT=test');
  });
});

// ---------------------------------------------------------------------------
// quoteExtraArgs() — SECURITY regression suite.
//
// `extraArgs` is the only free-form run field, it reaches the Hub over an
// unauthenticated loopback API, and the Hub spawns the built command as ONE
// string through a shell. Before this suite the value was passed through
// verbatim, so `--headed; <cmd>` ran `<cmd>`. Every case below asserts the
// metacharacter survives as DATA inside a quoted word: no unquoted `;`, `&&`,
// `|`, backtick or `$(` may appear in the emitted fragment.
//
// Needs no manifest, so it runs even when the tool repos are absent (CI).
// ---------------------------------------------------------------------------

describe('quoteExtraArgs', () => {
  /** The Hub's real quoter (hub/server/src/services/command-builder.ts). */
  const shellQuote = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;
  const identity = (v: string): string => v;

  it('quotes each word so a command separator cannot start a second command', () => {
    expect(quoteExtraArgs('--headed; rm -rf out', shellQuote)).toBe("'--headed;' 'rm' '-rf' 'out'");
  });

  it.each([
    ['&& chained', '--headed && whoami'],
    ['| piped', '--headed | whoami'],
    ['backtick substitution', '--grep `whoami`'],
    ['$() substitution', '--grep $(whoami)'],
    ['newline injection', '--headed\nwhoami'],
    ['redirect', '--headed > out.txt'],
  ])('leaves no unquoted shell metacharacter for %s', (_name, raw) => {
    const emitted = quoteExtraArgs(raw, shellQuote);
    // Strip every single-quoted span; whatever remains is what the shell parses.
    const outsideQuotes = emitted.replace(/'(?:[^']|'\\'')*'/g, '');
    expect(outsideQuotes.trim()).toBe('');
    expect(outsideQuotes).not.toMatch(/[;&|`$<>\n]/);
  });

  it('keeps ordinary flags usable — value flags, = flags and regex greps', () => {
    expect(quoteExtraArgs('--workers=2', shellQuote)).toBe("'--workers=2'");
    expect(quoteExtraArgs('--loglevel DEBUG', shellQuote)).toBe("'--loglevel' 'DEBUG'");
    expect(quoteExtraArgs('--grep (?=.*@a)', shellQuote)).toBe("'--grep' '(?=.*@a)'");
  });

  it('treats a quoted value as ONE word', () => {
    expect(quoteExtraArgs('--grep "@smoke a"', shellQuote)).toBe("'--grep' '@smoke a'");
    expect(quoteExtraArgs("--grep '@smoke a'", shellQuote)).toBe("'--grep' '@smoke a'");
  });

  it("escapes a single quote inside a word so the quoting can't be broken out of", () => {
    // Closed double quotes make the apostrophe part of the word; the quoter then
    // has to escape it, which is the only way out of a single-quoted span.
    expect(quoteExtraArgs(`--grep "it's"`, shellQuote)).toBe("'--grep' 'it'\\''s'");
    // A bare quote is a DELIMITER (shell semantics), so it is consumed, not kept.
    expect(quoteExtraArgs("--grep it's", shellQuote)).toBe("'--grep' 'its'");
  });

  it('is structurally transparent under the identity quote (CLI parity)', () => {
    expect(quoteExtraArgs('--workers=2', identity)).toBe('--workers=2');
    expect(quoteExtraArgs('--loglevel DEBUG', identity)).toBe('--loglevel DEBUG');
    // Collapses runs of whitespace — the words are what the shell would see.
    expect(quoteExtraArgs('  --headed   --workers=2  ', identity)).toBe('--headed --workers=2');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(quoteExtraArgs('   ', shellQuote)).toBe('');
    expect(quoteExtraArgs('', shellQuote)).toBe('');
  });
});
