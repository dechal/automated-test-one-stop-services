import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createManifestRegistry, isTemplate, listDirs } from './manifests/index.js';
import type { ToolManifest } from './manifests/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function projectsByType(tool: ToolManifest): Array<{ type: string; projects: string[] }> {
  const root = path.join(ROOT, 'tools', tool.id, tool.projects.root);
  const types = tool.projects.typeAxis
    ? listDirs(root)
    : tool.projects.fixedType !== null
      ? [tool.projects.fixedType]
      : [''];
  return types.map((type) => ({
    type: type || tool.id,
    projects: listDirs(path.join(root, type)).filter((p) => !isTemplate(p)),
  }));
}

function status(tools: readonly ToolManifest[]): void {
  console.log('\nProjects Overview');
  console.log('='.repeat(76));
  if (tools.length === 0) console.log('\n  (no tools installed under tools/)');
  for (const tool of tools) {
    console.log(`\n  ${tool.title}:`);
    for (const { type, projects } of projectsByType(tool)) {
      console.log(`     [${type}]: ${projects.length > 0 ? projects.join(' ') : '(none)'}`);
    }
  }
  console.log(`\n${'='.repeat(76)}`);
  console.log("  Use 'task create-project' to scaffold a new project\n");
}

function commands(tools: readonly ToolManifest[]): void {
  if (tools.length === 0) console.log('  (no tools installed under tools/)');
  for (const tool of tools) {
    for (const cmd of Object.values(tool.pipeline.runCommands)) console.log(`  ${cmd}`);
  }
}

function doctor(tools: readonly ToolManifest[]): void {
  for (const tool of tools) {
    for (const req of tool.requires) {
      const res = spawnSync([req.cmd, ...req.args].join(' '), { encoding: 'utf8', shell: true });
      const version = res.status === 0 ? (res.stdout.trim().split('\n')[0] ?? '') : '';
      const label = req.optional ? 'OPTIONAL' : 'MISSING';
      console.log(
        version
          ? `  [OK] ${req.cmd} ${version}`
          : `  [${label}] ${req.cmd} not found (${tool.id}) ${req.hint}`,
      );
    }
  }
}

const MODES: Readonly<Record<string, (tools: readonly ToolManifest[]) => void>> = {
  status,
  commands,
  doctor,
};

async function main(): Promise<void> {
  const mode = process.argv[2] ?? '';
  const run = MODES[mode];
  if (run === undefined) {
    console.error(`usage: tools-info.ts <${Object.keys(MODES).join('|')}>`);
    process.exitCode = 2;
    return;
  }
  const registry = createManifestRegistry(ROOT);
  await registry.refresh();
  run([...registry.enabled()].sort((a, b) => a.id.localeCompare(b.id)));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
