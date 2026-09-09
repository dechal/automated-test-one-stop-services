import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolManifest } from './types.js';

const ROOT_PYPROJECT = 'pyproject.toml';

const UV_WORKSPACE_SECTION = '[tool.uv.workspace]';

const MEMBERS_ENTRY = /(members\s*=\s*)\[[^\]]*\]/;

function sectionBody(toml: string): { body: string; start: number } | null {
  const start = toml.indexOf(UV_WORKSPACE_SECTION);
  if (start === -1) return null;
  const after = start + UV_WORKSPACE_SECTION.length;
  const next = toml.slice(after).search(/\n\[/);
  const end = next === -1 ? toml.length : after + next;
  return { body: toml.slice(after, end), start: after };
}

function parseMembers(body: string): string[] {
  const found = MEMBERS_ENTRY.exec(body);
  if (found === null) return [];
  const inner = found[0].slice(found[0].indexOf('[') + 1, -1);
  return inner
    .split(',')
    .map((raw) => raw.trim().replace(/^['"]|['"]$/g, ''))
    .filter((entry) => entry !== '');
}

export function desiredUvMembers(workspaceRoot: string, tools: readonly ToolManifest[]): string[] {
  return tools
    .filter(
      (tool) =>
        tool.packageManager === 'uv' &&
        fs.existsSync(path.join(workspaceRoot, 'tools', tool.id, ROOT_PYPROJECT)),
    )
    .map((tool) => `tools/${tool.id}`)
    .sort();
}

export function syncUvWorkspaceMembers(
  workspaceRoot: string,
  tools: readonly ToolManifest[],
): string | null {
  const abs = path.join(workspaceRoot, ROOT_PYPROJECT);
  if (!fs.existsSync(abs)) return null;

  const toml = fs.readFileSync(abs, 'utf8');
  const section = sectionBody(toml);
  if (section === null) return null;
  if (!MEMBERS_ENTRY.test(section.body)) {
    console.warn(
      `⚠ ${ROOT_PYPROJECT}: ${UV_WORKSPACE_SECTION} has no "members" entry — leaving it alone`,
    );
    return null;
  }

  const desired = desiredUvMembers(workspaceRoot, tools);
  const current = parseMembers(section.body);
  if (current.length === desired.length && current.every((entry, i) => entry === desired[i])) {
    return null;
  }

  const rendered = desired.length === 0 ? '[]' : `[${desired.map((m) => `"${m}"`).join(', ')}]`;
  const patchedBody = section.body.replace(MEMBERS_ENTRY, `$1${rendered}`);
  const patched =
    toml.slice(0, section.start) + patchedBody + toml.slice(section.start + section.body.length);

  fs.writeFileSync(abs, patched, 'utf8');
  return ROOT_PYPROJECT;
}
