// @ts-check
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKSPACE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @param {string} file
 * @returns {string[]}
 */
function cleanPathsOf(file) {
  try {
    const paths = JSON.parse(readFileSync(file, 'utf8'))?.clean?.paths;
    return Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * @param {string} [workspaceRoot]
 * @returns {string[]}
 */
export function toolArtefactDirs(workspaceRoot = WORKSPACE_ROOT) {
  const toolsDir = join(workspaceRoot, 'tools');
  if (!existsSync(toolsDir)) return [];
  return readdirSync(toolsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => cleanPathsOf(join(toolsDir, entry.name, 'tool.manifest.json')));
}
