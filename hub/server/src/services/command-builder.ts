import type { RunRequest, ToolId } from '@hub/shared';
import { getManifestModule, getToolManifest } from './manifest-registry.js';

/**
 * Build the `task …` command for a run, delegating to the canonical manifest
 * runner builder in `scripts/manifests/runner-command.ts`. This keeps the Hub
 * byte-for-byte in step with the interactive CLI runner — there are NO tool
 * literals here (k6 `SECTION`/`PERFORMANCE_TYPE`, robot `HEADLESS`, playwright
 * `--headed` all come from the tool's manifest). A shared parity test asserts
 * the CLI and Hub emit identical strings for the built-ins (anti-drift).
 *
 * Async because the manifest is loaded from the manifest registry. The
 * `TRACK=none` opt-out (usage-logging) is a Hub orchestration concern, so it is
 * layered on here rather than in the shared builder.
 */
export async function buildTaskCommand(req: RunRequest): Promise<string> {
  const [manifest, mod] = await Promise.all([getToolManifest(req.tool), getManifestModule()]);
  if (manifest === undefined) {
    throw new Error(`Unknown or disabled tool: ${req.tool}`);
  }
  const command = mod.buildRunCommandFromInput(manifest, {
    mode: manifest.compose === undefined ? 'local' : req.mode,
    type: req.type,
    project: req.project,
    tag: req.tag,
    section: req.section,
    performanceType: req.performanceType,
    headless: req.headless === 'headless' ? true : req.headless === 'headed' ? false : undefined,
    extraArgs: req.extraArgs,
    quote: shellQuote,
  });
  return req.noTrack ? withTrackNone(command) : command;
}

/** Single-quote a value for safe shell pass-through (handles regex like `(?=.*@x)`). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Insert `TRACK=none` as a task variable, BEFORE any `--` cli separator. This
 * mirrors the legacy Hub placement so the usage-logging opt-out is parsed by
 * `task` (a task variable) rather than forwarded to the underlying test command
 * as a cli arg.
 */
function withTrackNone(command: string): string {
  const sep = ' -- ';
  const idx = command.indexOf(sep);
  if (idx === -1) return `${command} TRACK=none`;
  return `${command.slice(0, idx)} TRACK=none${command.slice(idx)}`;
}

/**
 * Build the `task <ns>:tags …` command. The task namespace is sourced from the
 * tool's manifest (no hardcoded alias map); falls back to the tool id when the
 * manifest is unavailable so the call degrades instead of throwing.
 */
export async function buildTagsCommand(
  tool: ToolId,
  type: string,
  project: string,
): Promise<string> {
  const ns = (await getToolManifest(tool))?.runner.taskNamespace ?? String(tool);
  return `task ${ns}:tags PROJECT=${shellQuote(project)} TYPE=${shellQuote(type)} TRACK=none`;
}

/**
 * Build the `playwright test --list` command (run via `task <ns>:run-local`)
 * used by the tags fallback to scrape `@tag` annotations. The namespace is
 * manifest-sourced; the `--list` strategy itself is selected by the caller
 * (`routes/tags.ts`, manifest `tags.strategy`).
 */
export async function buildPlaywrightListCommand(
  tool: ToolId,
  type: string,
  project: string,
): Promise<string> {
  const ns = (await getToolManifest(tool))?.runner.taskNamespace ?? String(tool);
  return `task ${ns}:run-local PROJECT=${shellQuote(project)} TYPE=${shellQuote(type)} TRACK=none -- --list`;
}
