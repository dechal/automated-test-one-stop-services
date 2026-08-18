// scripts/manifests/runner-command.ts
//
// Pure, deterministic `task` command builder for the interactive runner.
// Given a validated manifest and a set of collected answers,
// it produces the exact shell command the runner spawns — with NO prompts and
// NO filesystem / process IO. This is the seam that replaces the hardcoded
// `toolMapping` / `tool === 'k6'` command construction in `scripts/runner.ts`.
//
// Reproduces the legacy command strings for every tool / answer combination
// (kept pure and deterministic, covered by a property test) with two reconciliations
// that keep the output identical to the pre-refactor runner:
//
//   1. The task target is sourced from the matching
//      `runner.executionTypes[].commandTemplate` (e.g. `{ns}:tags`) rather than
//      the top-level `runner.commandTemplate` (`{ns}:{executionType}-{env}`).
//      The latter would emit `pw:tags-local`; legacy emits `pw:tags`.
//   2. `dockerOverride` is applied in the `docker` environment even when a
//      step's `when` clause would otherwise gate it to `local`. The `when`
//      clause governs prompt VISIBILITY (the renderer); `dockerOverride` is the
//      build-time docker value for a step that is only prompted locally. This
//      reproduces legacy's forced `--variable HEADLESS:True` for Robot/docker
//      when running in docker.
import type {
  ToolManifest,
  ToolRunnerSelectStep,
  ToolRunnerStep,
  ToolRunnerWhen,
} from './types.js';
import { resolveCapabilities } from './validate.js';

/**
 * Answers collected by the runner prompt loop. `executionType` and
 * `environment` are always present; every other key is a `step.id` mapped to
 * its resolved string value.
 */
export interface RunnerAnswers {
  readonly executionType: string;
  readonly environment: 'local' | 'docker';
  readonly [stepId: string]: string;
}

/**
 * Execution context for the capability-driven builders.
 *
 * `mode` is the local/docker selector — it is the same axis as
 * `RunnerAnswers.environment`, surfaced under the name the Hub command-builder
 * uses when it maps its `RunRequest` onto this shared builder.
 * `headless` carries the headed/headless intent for tools that declare a
 * `run.headlessVar` (Robot Framework); tools without one (Playwright, k6)
 * ignore it. `undefined` means "unspecified" — locally it emits no headless
 * token, mirroring the Hub's pre-consolidation behaviour.
 */
export interface RunnerContext {
  readonly mode: 'local' | 'docker';
  readonly headless?: boolean;
}

/**
 * Build the full `task …` command for a tool given the collected answers.
 *
 * Task-style args (`passAs.kind === 'task'`) become `KEY=VALUE` tokens in
 * manifest-step order; cli-style args (`passAs.kind === 'cli'`) are appended
 * after a `--` separator in step order. Empty values are dropped so optional
 * prompts (empty tag, headless mode) leave no residue. Pure and deterministic.
 */
export function buildTaskCommand(manifest: ToolManifest, answers: RunnerAnswers): string {
  const taskBase = substitute(resolveCommandTemplate(manifest, answers.executionType), {
    ns: manifest.runner.taskNamespace,
    executionType: answers.executionType,
    environment: answers.environment,
  });

  const taskArgs: string[] = [];
  const cliArgs: string[] = [];

  for (const step of manifest.runner.steps) {
    if (!stepApplies(step, answers)) continue;
    const value = resolveValue(step, answers);
    if (value === '') continue;

    if (step.passAs.kind === 'task') taskArgs.push(`${step.passAs.key}=${value}`);
    else if (step.passAs.kind === 'cli') cliArgs.push(value);
  }

  const cliPart = cliArgs.length > 0 ? ` -- ${cliArgs.join(' ')}` : '';
  return `${taskBase} ${taskArgs.join(' ')}${cliPart}`.trim();
}

/**
 * Resolve the task target template for the chosen execution type. Falls back to
 * the top-level `commandTemplate` when no execution type matches. The per-type
 * template may omit the leading `task ` (the data model stores `{ns}:tags`), so
 * it is prefixed when absent to keep the emitted target uniform.
 */
function resolveCommandTemplate(manifest: ToolManifest, executionType: string): string {
  const match = manifest.runner.executionTypes.find((e) => e.id === executionType);
  if (match === undefined) return manifest.runner.commandTemplate;
  return match.commandTemplate.startsWith('task ')
    ? match.commandTemplate
    : `task ${match.commandTemplate}`;
}

/**
 * Whether a step contributes to the command. A step normally applies when its
 * `when` predicate matches; a step carrying a `dockerOverride` ALSO applies in
 * the `docker` environment regardless of `when`, so its forced docker value is
 * emitted even though the prompt itself is local-only.
 */
function stepApplies(step: ToolRunnerStep, answers: RunnerAnswers): boolean {
  if (answers.environment === 'docker' && step.dockerOverride !== undefined) return true;
  if (step.when === undefined) return true;
  return matchesWhen(step.when, answers);
}

/**
 * Resolve a step's effective value. In the `docker` environment a defined
 * `dockerOverride` wins over the collected answer; otherwise
 * the answer keyed by `step.id` is used, defaulting to the empty string.
 */
export function resolveValue(step: ToolRunnerStep, answers: RunnerAnswers): string {
  if (answers.environment === 'docker' && step.dockerOverride !== undefined) {
    return step.dockerOverride;
  }
  return answers[step.id] ?? '';
}

/**
 * Replace `{token}` placeholders in `template` with values from `vars`. Unknown
 * tokens collapse to the empty string. Used for both the task target template
 * and (via the step renderer) `from` / `preAction` substitution.
 */
export function substitute(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? '');
}

/**
 * Evaluate a `when` predicate against the current answers. Supports three
 * operand shapes per the data model: a literal string (equality), `{ $ne }`
 * (inequality), and `{ $in: [...] }` (membership). All clauses must hold (AND).
 */
export function matchesWhen(when: ToolRunnerWhen, answers: RunnerAnswers): boolean {
  for (const [key, expected] of Object.entries(when)) {
    const actual = answers[key];
    if (typeof expected === 'string') {
      if (actual !== expected) return false;
    } else if ('$ne' in expected) {
      if (actual === expected.$ne) return false;
    } else if ('$in' in expected) {
      if (actual === undefined || !expected.$in.includes(actual)) return false;
    }
  }
  return true;
}

/**
 * Build the capability-driven, tool-specific task vars (`KEY=VALUE`) declared by
 * `manifest.run.vars`, in declaration order. A var is emitted when:
 *   - `when: 'always'`      — unconditionally; or
 *   - `when: 'sectionAxis'` — only when `manifest.projects.sectionAxis` is true
 *     (k6 `SECTION`). Tools without a section axis silently drop it.
 *
 * The value is sourced from `values` keyed by the var `name` (e.g. `SECTION`,
 * `PERFORMANCE_TYPE`); an absent or empty value drops the token, mirroring the
 * empty-value handling in {@link buildTaskCommand}. A manifest with no `run`
 * block yields `[]` (safe default via `resolveCapabilities`). Pure +
 * deterministic — no FS / process IO.
 */
export function buildRunVarTokens(
  manifest: ToolManifest,
  values: Readonly<Record<string, string>>,
): string[] {
  const { vars } = resolveCapabilities(manifest).run;
  const tokens: string[] = [];
  for (const runVar of vars) {
    if (runVar.when === 'sectionAxis' && !manifest.projects.sectionAxis) continue;
    const value = values[runVar.name] ?? '';
    if (value === '') continue;
    tokens.push(`${runVar.name}=${value}`);
  }
  return tokens;
}

/**
 * Build the headless token from `manifest.run.headlessVar`, a
 * template carrying a single `{value}` placeholder that resolves to `True` /
 * `False` (e.g. Robot's `--variable HEADLESS:{value}`):
 *
 *   - `docker` mode forces `True` regardless of `context.headless` — this
 *     reproduces the legacy Robot `dockerOverride` (`--variable HEADLESS:True`,
 *     forced by docker mode);
 *   - `local` mode with `context.headless === undefined` emits `''` (no token),
 *     matching the Hub's "headless unspecified" behaviour;
 *   - `local` mode otherwise emits the template with `True` (headless) or
 *     `False` (headed).
 *
 * Tools that declare no `headlessVar` (Playwright, k6) always return `''` — they
 * have no manifest-driven headless variable. Pure + deterministic.
 */
export function buildHeadlessToken(manifest: ToolManifest, context: RunnerContext): string {
  const { headlessVar } = resolveCapabilities(manifest).run;
  if (headlessVar === null) return '';
  if (context.mode === 'docker') return substitute(headlessVar, { value: 'True' });
  if (context.headless === undefined) return '';
  return substitute(headlessVar, { value: context.headless ? 'True' : 'False' });
}

/**
 * Neutral run context the Hub command-builder maps its `RunRequest` onto before
 * delegating to {@link buildRunCommandFromInput}. Keeping this
 * shape — and the mapping logic — in the shared module means the Hub and the
 * interactive CLI runner build commands from ONE place: no tool literals, no
 * duplicated command logic (anti-drift).
 *
 * `quote` is the value-escaping hook. The Hub injects its `shellQuote` (the
 * command is spawned through a shell, so regex tags like `(?=.*@x)` must be
 * single-quoted); the CLI runner / parity tests inject the identity function.
 * Quoting wraps the task-var VALUES (TYPE/PROJECT/TAG/SECTION/
 * PERFORMANCE_TYPE) and every WORD of `extraArgs` (see
 * {@link quoteExtraArgs}). The headless cli flag is manifest-sourced, never
 * caller-supplied, so it passes through verbatim.
 */
export interface RunCommandInput {
  readonly mode: 'local' | 'docker';
  readonly type?: string;
  readonly project?: string;
  readonly tag?: string;
  readonly section?: string;
  readonly performanceType?: string;
  /** `true` headless, `false` headed, `undefined` unspecified (no local token). */
  readonly headless?: boolean;
  readonly extraArgs?: string;
  readonly quote: (value: string) => string;
}

/**
 * Resolve the LOCAL headless/headed CLI value from the manifest's headless
 * selector step — the unique `select` step that passes as a `cli` arg AND
 * carries a `dockerOverride` (Playwright's `mode` → `--headed`/``, Robot's
 * `mode` → `--variable HEADLESS:True`/`:False`). The chosen value is the step
 * choice whose title names the requested intent: a title containing "headed"
 * is the headed choice, otherwise it is the headless one ("headless" never
 * contains the substring "headed"). Tools with no such step (k6) return `''`.
 *
 * Docker forcing is applied by the step's `dockerOverride` inside
 * {@link buildTaskCommand}, so this resolves the LOCAL intent only. Pure +
 * deterministic — no FS / process IO, no tool literals.
 */
export function resolveHeadlessStepValue(manifest: ToolManifest, headless: boolean): string {
  const step = manifest.runner.steps.find(
    (s): s is ToolRunnerSelectStep =>
      s.kind === 'select' && s.passAs.kind === 'cli' && s.dockerOverride !== undefined,
  );
  if (step === undefined) return '';
  const wantHeaded = !headless;
  const choice = step.choices.find((c) =>
    wantHeaded ? /headed/i.test(c.title) : !/headed/i.test(c.title),
  );
  return choice?.value ?? '';
}

/**
 * Split a free-form argument string into shell WORDS, honouring single and
 * double quotes so a quoted value stays one word (`--grep "@a b"` → two words).
 * Pure — no shell, no expansion: `$VAR`, backticks and `$(…)` stay literal
 * characters, which is the point.
 */
function tokenizeArgs(raw: string): string[] {
  const words: string[] = [];
  let word = '';
  let open = false;
  let quoteChar: "'" | '"' | null = null;
  for (const ch of raw) {
    if (quoteChar !== null) {
      if (ch === quoteChar) quoteChar = null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quoteChar = ch;
      open = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (open) {
        words.push(word);
        word = '';
        open = false;
      }
      continue;
    }
    word += ch;
    open = true;
  }
  if (open) words.push(word);
  return words;
}

/**
 * Quote every word of a caller-supplied extra-args string.
 *
 * `extraArgs` is the ONE run field that is free-form text, and the Hub spawns
 * the built command as a single string through a shell — so an unquoted value
 * containing `;`, `&&`, `|`, a backtick or `$(…)` would start a SECOND command
 * with the Hub user's privileges. Quoting per word keeps every flag working
 * (`--workers=2`, `--grep (?=.*@a)`, `--loglevel DEBUG`) while making every
 * shell metacharacter inert: it becomes an argument the test runner rejects,
 * not a command the shell runs.
 *
 * Per-word rather than whole-string, because the shell must still see the words
 * as separate arguments. With the identity quote (CLI runner, parity tests) the
 * output is the input re-joined by single spaces, so the structural form is
 * unchanged.
 */
export function quoteExtraArgs(extraArgs: string, quote: (value: string) => string): string {
  return tokenizeArgs(extraArgs).map(quote).join(' ');
}

/**
 * Build the `task …` run command for the Hub from a neutral
 * {@link RunCommandInput}, delegating to {@link buildTaskCommand}.
 *
 * The Hub's run fields are mapped onto the manifest's runner answer keys
 * (`type`/`project`/`tag`/`section`/`performance_type`/`mode`/`args`) — the
 * canonical step-id vocabulary the built-in manifests use. Task-var values are
 * shell-quoted via `input.quote`; the headless `mode` value is resolved from the
 * manifest's headless step for LOCAL runs (docker forcing is applied by
 * `buildTaskCommand` via the step's `dockerOverride`). Always uses the `run`
 * execution type. Pure — no FS / process IO. (The Hub layers `TRACK=none`
 * opt-out on top of the returned string.)
 */
export function buildRunCommandFromInput(manifest: ToolManifest, input: RunCommandInput): string {
  const extra: Record<string, string> = {};
  if (input.type !== undefined && input.type !== '') extra.type = input.quote(input.type);
  if (input.project !== undefined && input.project !== '') {
    extra.project = input.quote(input.project);
  }
  if (input.tag !== undefined && input.tag !== '') extra.tag = input.quote(input.tag);
  if (input.section !== undefined && input.section !== '') {
    extra.section = input.quote(input.section);
  }
  if (input.performanceType !== undefined && input.performanceType !== '') {
    extra.performance_type = input.quote(input.performanceType);
  }
  if (input.extraArgs !== undefined && input.extraArgs !== '') {
    extra.args = quoteExtraArgs(input.extraArgs, input.quote);
  }
  // Headless is a cli-step value resolved from the manifest. Docker forcing is
  // handled by `buildTaskCommand` via the step's `dockerOverride`, so we only
  // resolve the local intent; an unspecified local headless emits no token.
  if (input.mode === 'local' && input.headless !== undefined) {
    extra.mode = resolveHeadlessStepValue(manifest, input.headless);
  }

  const answers: RunnerAnswers = {
    executionType: 'run',
    environment: input.mode,
    ...extra,
  };
  return buildTaskCommand(manifest, answers);
}
