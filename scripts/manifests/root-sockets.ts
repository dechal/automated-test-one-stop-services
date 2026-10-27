import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolManifest } from './types.js';

export const ROOT_TASKFILE_INCLUDES = 'Taskfile.tools.yml';
export const ROOT_COMPOSE = 'docker-compose.yml';
export const ROOT_COMPOSE_PROJECT = 'automated-test-one-stop-service-server';

function toolPath(id: string, file: string): string {
  return `./${path.posix.join('tools', id, file.replace(/\\/g, '/'))}`;
}

function writeIfChanged(workspaceRoot: string, file: string, content: string): string | null {
  const abs = path.join(workspaceRoot, file);
  const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  if (current === content) return null;
  fs.writeFileSync(abs, content, 'utf8');
  return file;
}

function present(workspaceRoot: string, tool: ToolManifest, file: string): boolean {
  return fs.existsSync(path.join(workspaceRoot, 'tools', tool.id, file));
}

function byId(tools: readonly ToolManifest[]): ToolManifest[] {
  return [...tools].sort((a, b) => a.id.localeCompare(b.id));
}

export function renderTaskfileIncludes(
  workspaceRoot: string,
  tools: readonly ToolManifest[],
): string {
  const lines = ['# GENERATED from tools/*/tool.manifest.json by sync-projects — do not edit.'];
  lines.push('version: "3"');
  const wired = byId(tools).filter((t) => present(workspaceRoot, t, t.taskfile));
  if (wired.length === 0) {
    lines.push('tasks: {}');
    return `${lines.join('\n')}\n`;
  }
  lines.push('includes:');
  for (const tool of wired) {
    lines.push(`  ${tool.runner.taskNamespace}:`);
    lines.push(`    taskfile: ${toolPath(tool.id, tool.taskfile)}`);
    lines.push(`    dir: ${toolPath(tool.id, '.')}`);
    lines.push('    optional: true');
  }
  return `${lines.join('\n')}\n`;
}

export function renderRootCompose(workspaceRoot: string, tools: readonly ToolManifest[]): string {
  const lines = ['# GENERATED from tools/*/tool.manifest.json by sync-projects — do not edit.'];
  lines.push(`name: ${ROOT_COMPOSE_PROJECT}`);
  const files = byId(tools)
    .map((t) => ({ tool: t, file: t.compose.services }))
    .filter((e): e is { tool: ToolManifest; file: string } => e.file !== undefined)
    .filter((e) => present(workspaceRoot, e.tool, e.file));
  if (files.length === 0) {
    lines.push('services: {}');
    return `${lines.join('\n')}\n`;
  }
  lines.push('include:');
  for (const { tool, file } of files) lines.push(`  - ${toolPath(tool.id, file)}`);
  return `${lines.join('\n')}\n`;
}

export function syncRootSockets(workspaceRoot: string, tools: readonly ToolManifest[]): string[] {
  return [
    writeIfChanged(
      workspaceRoot,
      ROOT_TASKFILE_INCLUDES,
      renderTaskfileIncludes(workspaceRoot, tools),
    ),
    writeIfChanged(workspaceRoot, ROOT_COMPOSE, renderRootCompose(workspaceRoot, tools)),
  ].filter((f): f is string => f !== null);
}
