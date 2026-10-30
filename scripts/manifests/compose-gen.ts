// scripts/manifests/compose-gen.ts
//
// Manifest-driven generator for a tool's `docker-compose.yml`. Replaces the
// hardcoded per-tool `generateDockerCompose(...)` calls that used to live in
// `scripts/sync-projects.ts`.
//
// Behaviour:
//   - Reads the compose template named by `manifest.compose.template` from the
//     tool's folder.
//   - Re-emits everything up to and including the `services:` line, then writes
//     one service entry per NON-TEMPLATE project, each
//     aliasing the template anchor `manifest.compose.anchor`.
//   - Appends an external `networks:` block when `compose.networks` is non-empty.
//   - When the template is absent it logs a warning and returns WITHOUT throwing
//     so a single broken tool never aborts the whole sync (broken-manifest
//     tolerance).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listProjectDirs } from './fs-helpers.js';
import type { ToolManifest } from './types.js';

/**
 * Generate `tools/<id>/docker-compose.yml` for a single tool from its compose
 * template + discovered projects. IO-only; never throws on a missing or
 * malformed template (logs and returns instead).
 */
export function generateDockerCompose(workspaceRoot: string, tool: ToolManifest): void {
  const compose = tool.compose;
  if (compose === undefined) return;
  const toolDir = path.join(workspaceRoot, 'tools', tool.id);
  const templatePath = path.join(toolDir, compose.template);
  if (!fs.existsSync(templatePath)) {
    console.error(`⚠ Compose template missing for ${tool.id}: ${templatePath}`);
    return;
  }

  const targetPath = path.join(toolDir, 'docker-compose.yml');
  // Normalise CRLF → LF: tool repos cloned on Windows may be checked out with
  // CRLF line endings, which would break the `services:\n` anchor search below
  // and the workspace's LF convention. Generated output is always LF.
  const content = fs.readFileSync(templatePath, 'utf8').replace(/\r\n/g, '\n');

  const servicesIdx = content.indexOf('services:\n');
  if (servicesIdx === -1) {
    console.error(`⚠ Invalid template (no services:): ${templatePath}`);
    return;
  }

  let yamlOutput = content.substring(0, servicesIdx + 'services:\n'.length);
  const projects = listProjectDirs(toolDir, tool.projects);

  for (const proj of projects) {
    yamlOutput += `  ${proj}:\n`;
    yamlOutput += `    <<: *${compose.anchor}\n`;
    yamlOutput += `    container_name: ${proj}\n\n`;
  }

  if (compose.networks.length > 0) {
    yamlOutput += `networks:\n`;
    for (const network of compose.networks) {
      yamlOutput += `  ${network}:\n    external: true\n`;
    }
  }

  fs.writeFileSync(targetPath, yamlOutput, 'utf8');
  console.log(`✅ ${tool.id} → docker-compose.yml (${projects.length} projects)`);
}
