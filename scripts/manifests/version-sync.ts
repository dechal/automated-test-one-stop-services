import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolManifest, ToolVersionSourceConfig } from './types.js';

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

const VERSION_ENTRY = /("version"\s*:\s*)"[^"]*"/g;

interface PackageJsonLike {
  readonly [field: string]: Record<string, string> | undefined;
}

function stripRangeOperator(spec: string): string {
  return spec.replace(/^[^0-9]*/, '').trim();
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readJsonPin(abs: string, dependency: string): string {
  const parsed = JSON.parse(fs.readFileSync(abs, 'utf8')) as PackageJsonLike;
  for (const field of DEP_FIELDS) {
    const spec = parsed[field]?.[dependency];
    if (typeof spec === 'string') return spec;
  }
  return '';
}

function readRequirementPin(abs: string, dependency: string): string {
  const pattern = new RegExp(`["']${escapeForRegExp(dependency)}\\s*[<>=!~^]+\\s*([^"',]+)["']`);
  return pattern.exec(fs.readFileSync(abs, 'utf8'))?.[1]?.trim() ?? '';
}

export function readToolVersionPin(toolDir: string, source: ToolVersionSourceConfig): string {
  const abs = path.join(toolDir, source.file);
  if (!fs.existsSync(abs)) return '';
  const raw = abs.endsWith('.json')
    ? readJsonPin(abs, source.dependency)
    : readRequirementPin(abs, source.dependency);
  return stripRangeOperator(raw);
}

export function syncToolVersion(workspaceRoot: string, tool: ToolManifest): string | null {
  const source = tool.versionFrom;
  if (source === undefined) return null;

  const toolDir = path.join(workspaceRoot, 'tools', tool.id);
  const manifestPath = path.join(toolDir, 'tool.manifest.json');
  if (!fs.existsSync(manifestPath)) return null;

  const pin = readToolVersionPin(toolDir, source);
  if (pin === '') {
    console.warn(
      `⚠ ${tool.id}: versionFrom points at ${source.dependency} in ${source.file}, which has no version — leaving manifest.version alone`,
    );
    return null;
  }
  if (pin === tool.version) return null;

  const raw = fs.readFileSync(manifestPath, 'utf8');
  const hits = raw.match(VERSION_ENTRY) ?? [];
  if (hits.length !== 1) {
    console.warn(
      `⚠ ${tool.id}: expected exactly 1 "version" entry in tool.manifest.json, found ${hits.length} — leaving it alone`,
    );
    return null;
  }

  const patched = raw.replace(VERSION_ENTRY, `$1"${pin}"`);
  try {
    JSON.parse(patched);
  } catch {
    console.warn(`⚠ ${tool.id}: patching manifest.version would produce invalid JSON — skipped`);
    return null;
  }

  fs.writeFileSync(manifestPath, patched, 'utf8');
  return path.relative(workspaceRoot, manifestPath);
}
