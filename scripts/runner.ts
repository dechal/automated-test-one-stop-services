// scripts/runner.ts
//
// Interactive runner for the One-Stop Service QA CLI.
//
// Manifest-driven prompt loop via `createManifestRegistry`.
// Shared spawn behaviour: save the command to `.last-run`,
// filter pnpm from PATH (MSYS workaround), then `spawn(cmd, { shell, stdio })`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prompts from 'prompts';

import { runUsageLog } from './lib/usage-log.mjs';
import { createManifestRegistry } from './manifests/index.js';
import { buildTaskCommand, matchesWhen, type RunnerAnswers } from './manifests/runner-command.js';
import {
  BACK_SENTINEL,
  type RenderResult,
  renderStep,
  runPreAction,
} from './manifests/runner-step-render.js';
import type { ToolManifest } from './manifests/types.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const LAST_RUN_FILE = path.join('.cache', 'state', 'last-run');

const currentDir =
  typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

const WORKSPACE_ROOT = path.resolve(currentDir, '..');

// ─── Shared helpers ───────────────────────────────────────────────────────────

function saveLastRun(command: string): void {
  const lastRunPath = path.join(process.cwd(), LAST_RUN_FILE);
  fs.mkdirSync(path.dirname(lastRunPath), { recursive: true });
  fs.writeFileSync(lastRunPath, command, 'utf8');
}

/**
 * Validate that a project's `.env` file exists and contains all keys declared
 * in `.env.template`. Prints guidance on mismatch. Returns false to abort.
 */
function validateProjectEnvByPath(projectDir: string, project: string): boolean {
  const envTemplatePath = path.join(projectDir, '.env.template');
  const envPath = path.join(projectDir, '.env');

  if (!fs.existsSync(envTemplatePath)) return true;

  if (!fs.existsSync(envPath)) {
    console.error(`\n[ERROR] Missing .env file for project '${project}'`);
    console.error(`   -> Copy from: ${path.relative(process.cwd(), envTemplatePath)}`);
    console.error(
      `   -> Run: cp ${path.relative(process.cwd(), envTemplatePath)} ${path.relative(process.cwd(), envPath)}`,
    );
    console.error(`   -> Then edit the values inside .env\n`);
    return false;
  }

  const templateContent = fs.readFileSync(envTemplatePath, 'utf8');
  const envContent = fs.readFileSync(envPath, 'utf8');
  const missingKeys: string[] = [];

  for (const line of templateContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const key = trimmed.split('=')[0];
    if (key && !envContent.includes(`${key}=`)) {
      missingKeys.push(key);
    }
  }

  if (missingKeys.length > 0) {
    console.warn(`\n[WARN] Missing keys in .env for project '${project}':`);
    for (const key of missingKeys) {
      console.warn(`   * ${key}`);
    }
    console.warn(`   -> Compare with .env.template and add missing keys\n`);
  }

  return true;
}

/**
 * Spawn the command: filter pnpm from PATH (MSYS workaround), print the
 * command in cyan, then spawn with inherited stdio. Mirrors the legacy runner.
 */
function spawnCommand(fullCommand: string): void {
  console.log(`\nExecuting: \x1b[36m${fullCommand}\x1b[0m\n`);

  const env = { ...process.env };
  if (env.PATH) {
    env.PATH = env.PATH.split(path.delimiter)
      .filter((p) => !p.includes('@pnpm'))
      .join(path.delimiter);
  }

  const child = spawn(fullCommand, {
    shell: true,
    stdio: 'inherit',
    env,
  });

  process.on('SIGINT', () => {
    console.log('\nGracefully shutting down...');
    child.kill('SIGINT');
    process.exit(1);
  });

  child.on('close', (code) => {
    console.log(`\nProcess exited with code ${code}`);
    process.exit(code ?? 0);
  });
}

// ─── Manifest-driven runner ──────────────────────────────────────────────────

/**
 * Resolve the project directory for env validation from manifest + answers.
 */
function resolveProjectDir(manifest: ToolManifest, answers: Record<string, string>): string {
  const toolDir = path.join(WORKSPACE_ROOT, 'tools', manifest.id);
  if (manifest.projects.typeAxis) {
    const type = answers.type ?? '';
    const project = answers.project ?? '';
    return path.join(toolDir, manifest.projects.root, type, project);
  }
  const fixedType = manifest.projects.fixedType ?? '';
  const project = answers.project ?? '';
  return path.join(toolDir, manifest.projects.root, fixedType, project);
}

async function runManifestCLI(): Promise<void> {
  console.log('Welcome to the One-Stop Service QA CLI\n');

  const registry = createManifestRegistry(WORKSPACE_ROOT);
  await registry.refresh();

  const enabledTools = registry.enabled();

  if (enabledTools.length === 0) {
    console.error('No valid tools found in the /tools directory.');
    process.exit(1);
  }

  // Step 1: pick tool
  const toolRes = await prompts({
    type: 'select',
    name: 'tool',
    message: 'Select the tool to run:',
    choices: [
      ...enabledTools.map((t) => ({ title: t.runner.title, value: t.id })),
      { title: 'Cancel', value: 'CANCEL' },
    ],
  });

  if (toolRes.tool === undefined || toolRes.tool === 'CANCEL') {
    process.exit(0);
  }

  const manifest = registry.byId(toolRes.tool);
  if (manifest === undefined) {
    console.error(`Tool '${toolRes.tool}' not found.`);
    process.exit(1);
  }

  // Accumulator for all answers; `executionType` and `environment` are set
  // before the step loop and guaranteed non-empty thereafter.
  const answers: Record<string, string> = {};

  // Step 2: pick execution type (skip when only one)
  if (manifest.runner.executionTypes.length > 1) {
    const execRes = await prompts({
      type: 'select',
      name: 'executionType',
      message: 'Select the execution type:',
      choices: [
        ...manifest.runner.executionTypes.map((e) => ({ title: e.title, value: e.id })),
        { title: '< Go Back', value: 'BACK' },
      ],
    });

    if (execRes.executionType === undefined || execRes.executionType === 'CANCEL') {
      process.exit(0);
    }
    if (execRes.executionType === 'BACK') {
      return runManifestCLI();
    }
    answers.executionType = execRes.executionType;
  } else {
    // Safe: we only enter this branch when executionTypes.length === 1
    const firstType = manifest.runner.executionTypes[0];
    if (firstType === undefined) {
      console.error('No execution types defined in manifest.');
      process.exit(1);
    }
    answers.executionType = firstType.id;
  }

  // Step 3: pick environment
  const envRes = await prompts({
    type: 'select',
    name: 'environment',
    message: 'Select the environment to run:',
    choices: [
      ...manifest.runner.environments.map((e) => ({
        title: e === 'local' ? 'Local' : 'Docker',
        value: e,
      })),
      { title: '< Go Back', value: 'BACK' },
    ],
  });

  if (envRes.environment === undefined || envRes.environment === 'CANCEL') {
    process.exit(0);
  }
  if (envRes.environment === 'BACK') {
    return runManifestCLI();
  }
  answers.environment = envRes.environment;

  // Step 4: walk declarative steps from the manifest
  const steps = manifest.runner.steps;
  const stepHistory: number[] = []; // indices of completed steps for back navigation
  let stepIdx = 0;

  while (stepIdx < steps.length) {
    const step = steps[stepIdx] as (typeof steps)[number];

    // Filter by `when` predicate
    if (step.when !== undefined && !matchesWhen(step.when, answers as RunnerAnswers)) {
      stepIdx++;
      continue;
    }

    // Run pre-action (e.g. print tags)
    runPreAction(step, manifest, answers);

    // Render the prompt
    const result: RenderResult = await renderStep(step, manifest, WORKSPACE_ROOT, answers);

    if (result === BACK_SENTINEL) {
      // Rewind: pop the last completed step and try again from there
      if (stepHistory.length > 0) {
        const prevIdx = stepHistory.pop() as number;
        const prevStep = steps[prevIdx] as (typeof steps)[number];
        delete answers[prevStep.id];
        stepIdx = prevIdx;
      } else {
        // No step to rewind to — restart the whole CLI
        return runManifestCLI();
      }
      continue;
    }

    answers[step.id] = result;
    stepHistory.push(stepIdx);
    stepIdx++;
  }

  // Step 5: optional Google Sheet tracking
  if (process.env.FORCE_TRACK !== 'true' && answers.executionType === 'run') {
    const trackRes = await prompts({
      type: 'select',
      name: 'trackUsage',
      message: 'Enable Google Sheet Usage Logging?',
      // 'No' first so it is the default (Enter) — a non-technical user must not
      // enable logging (which needs credentials + SPREADSHEET_ID) by accident.
      choices: [
        { title: 'No', value: 'no' },
        { title: 'Yes', value: 'yes' },
        { title: '< Go Back', value: 'BACK' },
      ],
    });

    if (trackRes.trackUsage === undefined || trackRes.trackUsage === 'CANCEL') {
      process.exit(0);
    }
    if (trackRes.trackUsage === 'BACK') {
      // Rewind to last step
      if (stepHistory.length > 0) {
        const prevIdx = stepHistory.pop() as number;
        const prevStep = steps[prevIdx] as (typeof steps)[number];
        delete answers[prevStep.id];
      }
      return runManifestCLI();
    }
    answers.trackUsage = trackRes.trackUsage;
  }

  // Step 6: build task command from manifest template
  const executionType = answers.executionType ?? '';
  const environment = (answers.environment ?? 'local') as 'local' | 'docker';
  const runnerAnswers: RunnerAnswers = {
    executionType,
    environment,
    ...answers,
  };

  let fullCommand = buildTaskCommand(manifest, runnerAnswers);

  // Append TRACK=none when the user opted out (mirroring legacy behaviour)
  if (answers.trackUsage !== 'yes' && process.env.FORCE_TRACK !== 'true') {
    fullCommand = `${fullCommand} TRACK=none`;
  }

  // Validate project .env before running
  if (answers.project) {
    const projectDir = resolveProjectDir(manifest, answers);
    const isValid = validateProjectEnvByPath(projectDir, answers.project);
    if (!isValid) {
      process.exit(1);
    }
  }

  // Fire best-effort Google Sheet usage logging BEFORE the run when tracking is
  // on (approach A: the run flow owns logging — the task layer does not consume
  // TRACK). Same opt-in as the TRACK=none opt-out above: an explicit "Yes" or a
  // FORCE_TRACK default, and only for an actual `run`. Auth is non-interactive
  // (silent token refresh, never a browser); a hiccup warns + skips, never blocks.
  const shouldTrack =
    answers.executionType === 'run' &&
    (answers.trackUsage === 'yes' || process.env.FORCE_TRACK === 'true');

  // Save and spawn
  saveLastRun(fullCommand);
  if (shouldTrack) {
    await runUsageLog({
      command: fullCommand,
      channel: 'local',
      cwd: WORKSPACE_ROOT,
      inheritStdio: true,
    });
  }
  spawnCommand(fullCommand);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

runManifestCLI().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
